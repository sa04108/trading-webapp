import { parseCorpCodeXml } from "./dart-corp-code-cache.js";
import { kstDateOf } from "../../../../../runtime/modules/market-data/domain/kst-date.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { DartRawSnapshotKey } from "./dart-raw-snapshot-store.js";

export interface DartPendingFiling {
  readonly receiptNo: string;
  readonly discoveredAtMs: number;
  readonly status: "PENDING" | "UNRESOLVED";
  readonly retryAfterMs: number | null;
}

export interface DartPendingFilingStore {
  get(key: DartRawSnapshotKey): DartPendingFiling | null;
  isCollected?(key: DartRawSnapshotKey): boolean;
  getExpectedCorpCode?(symbol: string): string | null;
  markApplied(key: DartRawSnapshotKey, receiptNo: string): void;
  markPendingPublication(key: DartRawSnapshotKey, receiptNo: string, retryAfterMs: number): void;
}

type ReconciliationOptions = { readonly shouldStop?: () => boolean };
type DiscoveredFilingRow = { identity:string; receipt_no:string|null; symbol:string|null; business_year:number|null; report_code:string|null; status:string; payload_json:string };
type RawSnapshotSummary = { readonly endpoint:string; readonly corrupt:boolean; readonly receipts:readonly string[] };

const SYMBOL_PAGE_SIZE = 8;
const ROW_PAGE_SIZE = 16;
const FILINGS_PER_TURN = 8;
const MAX_TURN_MS = 8;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 발견과 본문 반영을 접수번호·endpoint별로 분리해 한 소비자의 완료가 다른 소비자를 숨기지 않는다. */
export class SqliteDartPendingFilingStore implements DartPendingFilingStore {
  constructor(private readonly sqlite: Database.Database, private readonly corpNamespace?: string) {}

  getExpectedCorpCode(symbol: string): string | null {
    const row = this.sqlite.prepare(`SELECT payload_json FROM dart_discovered_filings
      WHERE symbol = ? ORDER BY receipt_no DESC LIMIT 1`).get(symbol) as {payload_json:string} | undefined;
    if (row === undefined) return null;
    try {
      const payload = JSON.parse(row.payload_json) as {corp_code?: unknown};
      return typeof payload.corp_code === "string" && /^\d{8}$/.test(payload.corp_code) ? payload.corp_code : null;
    } catch { return null; }
  }

  isCollected(key: DartRawSnapshotKey): boolean {
    const state = this.sqlite.prepare("SELECT covered_years_json, action_covered_years_json FROM symbol_facts_state WHERE code = ?")
      .get(key.symbol) as { covered_years_json: string; action_covered_years_json: string | null } | undefined;
    if (state === undefined) return false;
    const covered = key.endpoint === "FINANCIAL_STATEMENT" ? [state.covered_years_json]
      : key.endpoint === "ISSUANCE_STATUS" ? [state.action_covered_years_json]
        : [state.covered_years_json, state.action_covered_years_json];
    return covered.some((value) => {
      try { return (JSON.parse(value ?? "[]") as number[]).includes(key.businessYear); } catch { return false; }
    });
  }

  get(key: DartRawSnapshotKey): DartPendingFiling | null {
    const row = this.sqlite.prepare(`SELECT f.receipt_no, f.discovered_at_ms, f.status, c.retry_after_ms
      FROM dart_discovered_filings f LEFT JOIN dart_filing_endpoint_checkpoints c
      ON c.receipt_no = f.receipt_no AND c.endpoint = ? AND c.fs_div = ?
      WHERE f.status NOT IN ('APPLIED', 'BASELINE_UNKNOWN') AND f.symbol = ? AND f.business_year = ? AND f.report_code = ?
      AND (c.status IS NULL OR c.status != 'APPLIED')
      ORDER BY f.receipt_no DESC LIMIT 1`).get(key.endpoint, key.fsDiv, key.symbol, key.businessYear, key.reportCode) as {
        receipt_no: string; discovered_at_ms: number; status: "PENDING" | "UNRESOLVED"; retry_after_ms: number | null;
      } | undefined;
    return row === undefined ? null : {
      receiptNo: row.receipt_no, discoveredAtMs: row.discovered_at_ms,
      status: row.status, retryAfterMs: row.retry_after_ms,
    };
  }

  markApplied(key: DartRawSnapshotKey, receiptNo: string): void {
    const earlier = this.sqlite.prepare(`SELECT receipt_no FROM dart_discovered_filings
      WHERE symbol = ? AND business_year = ? AND report_code = ? AND receipt_no <= ?`)
      .all(key.symbol, key.businessYear, key.reportCode, receiptNo) as { receipt_no: string }[];
    this.sqlite.transaction(() => {
      for (const row of earlier) this.save(key, row.receipt_no, "APPLIED", null);
    })();
  }

  /**
   * 원문보다 새로운 공시만 입력을 차단하고 보고서 단위 재생 대상으로 돌려준다.
   * SQLite 동기 조회를 작은 묶음으로 나누어 HTTP 서버의 이벤트 루프를 오래 점유하지 않는다.
   */
  async reconcileDiscoveredFilings(
    options: ReconciliationOptions = {},
  ): Promise<{ symbol: string; year: number }[]> {
    const throwIfStopped = (): void => {
      if (options.shouldStop?.())
        throw new Error("공시 반영 상태 재평가가 취소되었습니다.");
    };
    // 시작 직후에도 양보해 큰 기존 공시 이력을 요청 처리와 경쟁시키지 않는다.
    await yieldToEventLoop();
    throwIfStopped();
    const savedMapping = this.corpNamespace === undefined ? undefined : this.sqlite.prepare(
      "SELECT xml, content_hash FROM dart_corp_code_snapshot WHERE namespace = ?").get(this.corpNamespace) as {xml:string;content_hash:string} | undefined;
    const knownMapping = savedMapping !== undefined && createHash("sha256").update(savedMapping.xml).digest("hex") === savedMapping.content_hash
      ? parseCorpCodeXml(savedMapping.xml) : new Map<string,string>();
    const affected = new Map<string, { symbol: string; year: number }>();
    let lastSymbol = "";
    let filingsSinceYield = 0;
    let turnStartedAt = Date.now();
    for (;;) {
      throwIfStopped();
      const symbols = this.sqlite.prepare(`SELECT symbol FROM dart_discovered_filings
        WHERE status != 'APPLIED' AND symbol > ? GROUP BY symbol ORDER BY symbol LIMIT ?`)
        .all(lastSymbol, SYMBOL_PAGE_SIZE) as Array<{symbol:string}>;
      if (symbols.length === 0) break;
      lastSymbol = symbols.at(-1)!.symbol;
      for (const { symbol } of symbols) {
        throwIfStopped();
        const collected = this.sqlite.prepare("SELECT covered_years_json, action_covered_years_json, financial_updated_at_ms, action_updated_at_ms FROM symbol_facts_state WHERE code = ?")
          .get(symbol) as {covered_years_json:string;action_covered_years_json:string|null;financial_updated_at_ms:number|null;action_updated_at_ms:number|null}|undefined;
        if (collected === undefined) continue;
        const knownCorps = new Set<string>();
        const mapped = knownMapping.get(symbol);
        if (mapped !== undefined) knownCorps.add(mapped);
        const rawByReport = new Map<string, RawSnapshotSummary[]>();
        let rawOffset = 0;
        for (;;) {
          const rawRows = this.sqlite.prepare(`SELECT business_year, report_code, endpoint, payload_json, content_hash
            FROM dart_raw_api_snapshots WHERE code = ? ORDER BY rowid LIMIT ? OFFSET ?`)
            .all(symbol, ROW_PAGE_SIZE, rawOffset) as Array<{business_year:number|null;report_code:string|null;endpoint:string;payload_json:string;content_hash:string}>;
          if (rawRows.length === 0) break;
          rawOffset += rawRows.length;
          for (const raw of rawRows) {
            if (Date.now() - turnStartedAt >= MAX_TURN_MS) {
              await yieldToEventLoop();
              throwIfStopped();
              turnStartedAt = Date.now();
            }
            const hashMatches = createHash("sha256").update(raw.payload_json).digest("hex") === raw.content_hash;
            let corrupt = !hashMatches;
            const receipts: string[] = [];
            if (hashMatches) {
              try {
                const payload = JSON.parse(raw.payload_json) as {list?:{corp_code?:unknown;rcept_no?:unknown}[]};
                for (const entry of payload.list ?? []) {
                  if (typeof entry.corp_code === "string") knownCorps.add(entry.corp_code);
                  if (typeof entry.rcept_no === "string") receipts.push(entry.rcept_no);
                }
              } catch { corrupt = true; }
            }
            const key = `${raw.business_year ?? "null"}\u0000${raw.report_code ?? "null"}`;
            const summaries = rawByReport.get(key) ?? [];
            summaries.push({endpoint: raw.endpoint, corrupt, receipts});
            rawByReport.set(key, summaries);
          }
          if (rawRows.length < ROW_PAGE_SIZE) break;
          await yieldToEventLoop();
          throwIfStopped();
          turnStartedAt = Date.now();
        }
        const years = [...JSON.parse(collected.covered_years_json), ...JSON.parse(collected.action_covered_years_json ?? "[]")] as number[];
        let filingCursor = 0;
        for (;;) {
          const filings = this.sqlite.prepare(`SELECT rowid AS cursor, identity, receipt_no, symbol, business_year, report_code, status, payload_json
            FROM dart_discovered_filings WHERE status != 'APPLIED' AND symbol = ? AND rowid > ? ORDER BY rowid LIMIT ?`)
            .all(symbol, filingCursor, ROW_PAGE_SIZE) as (DiscoveredFilingRow & {cursor:number})[];
          if (filings.length === 0) break;
          filingCursor = filings.at(-1)!.cursor;
          for (const filing of filings) {
            throwIfStopped();
            filingsSinceYield += 1;
            if (filingsSinceYield >= FILINGS_PER_TURN || Date.now() - turnStartedAt >= MAX_TURN_MS) {
              await yieldToEventLoop();
              throwIfStopped();
              filingsSinceYield = 0;
              turnStartedAt = Date.now();
            }
            let filingCorp: string | null = null;
            try {
              const payload = JSON.parse(filing.payload_json) as {corp_code?:unknown};
              if (typeof payload.corp_code === "string" && /^\d{8}$/.test(payload.corp_code)) filingCorp = payload.corp_code;
            } catch { /* 법인 식별자가 없는 옛 목록은 추측하여 채우지 않는다. */ }
            // 법인 정체성은 보고서 연도와 무관하다. 같은 종목의 원문은 이 pass에서 한 번만 해석한다.
            if (filingCorp !== null && [...knownCorps].some((corp) => corp !== filingCorp)) {
              throwIfStopped();
              this.sqlite.prepare(`INSERT OR IGNORE INTO provider_input_issues
                (id, symbol, business_year, report_code, reason, evidence) VALUES (?, ?, NULL, NULL, 'IDENTITY_CHANGED', ?)`)
                .run(`dart-identity:${symbol}`, symbol, `${[...knownCorps].join(",")} -> ${filingCorp}`);
              continue;
            }
            if (years.length === 0 || (filing.business_year !== null && !years.includes(filing.business_year))) continue;
            const rows = filing.business_year === null || filing.report_code === null ? [] :
              rawByReport.get(`${filing.business_year}\u0000${filing.report_code}`) ?? [];
            const existingIssue = this.sqlite.prepare("SELECT id FROM provider_input_issues WHERE id = ?").get(`dart-filing:${filing.identity}`);
            const receiptDay = filing.receipt_no?.slice(0, 8);
            const newerThanCheckpoint = receiptDay !== undefined && [
              [collected.covered_years_json, collected.financial_updated_at_ms],
              [collected.action_covered_years_json, collected.action_updated_at_ms],
            ].some(([covered, timestamp]) => typeof timestamp === "number" && timestamp > 0 &&
              (JSON.parse(String(covered ?? "[]")) as number[]).includes(filing.business_year ?? -1) &&
              receiptDay > kstDateOf(timestamp).replaceAll("-", ""));
            const earlierReceiptOrCorruption = rows.some((row) => row.corrupt ||
              row.receipts.some((receipt) => receipt < (filing.receipt_no ?? "")));
            if (existingIssue === undefined && filing.status !== "UNRESOLVED" && !newerThanCheckpoint && !earlierReceiptOrCorruption) {
              throwIfStopped();
              this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'BASELINE_UNKNOWN' WHERE identity = ?").run(filing.identity);
              continue;
            }
            if (filing.status === "BASELINE_UNKNOWN") {
              throwIfStopped();
              this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'PENDING' WHERE identity = ?").run(filing.identity);
            }
            if (existingIssue === undefined && filing.status !== "UNRESOLVED" &&
                ["FINANCIAL_STATEMENT", "SHARE_STATUS", "ISSUANCE_STATUS"].every((endpoint) => rows.some((row) => row.endpoint === endpoint)) &&
                rows.every((row) => !row.corrupt && row.receipts.some((receipt) => receipt >= (filing.receipt_no ?? "~")))) continue;
            throwIfStopped();
            this.sqlite.prepare(`INSERT OR IGNORE INTO provider_input_issues
              (id, symbol, business_year, report_code, reason, evidence) VALUES (?, ?, ?, ?, ?, ?)`)
              .run(`dart-filing:${filing.identity}`, symbol, filing.business_year, filing.report_code,
                filing.status === "UNRESOLVED" ? "UNRESOLVED_FILING" : "PENDING_FILING", filing.receipt_no ?? filing.identity);
            if (filing.business_year !== null && filing.report_code !== null && filing.status !== "UNRESOLVED")
              affected.set(`${symbol}:${filing.business_year}`, { symbol, year: filing.business_year });
          }
          if (filings.length < ROW_PAGE_SIZE) break;
        }
      }
    }
    return [...affected.values()];
  }

  /** 정상화 성공 후 모든 본문 endpoint가 같은 공시를 반영한 경우에만 입력 차단을 해제한다. */
  markNormalized(symbol: string, year: number, consumer: "ALL" | "FINANCIAL" | "ACTION" = "ALL"): void {
    if (consumer !== "ALL") return;
    this.sqlite.transaction(() => {
    this.sqlite.prepare(`UPDATE dart_discovered_filings SET status = 'APPLIED' WHERE identity IN (SELECT substr(id, 13) FROM provider_input_issues WHERE symbol = ? AND business_year = ?) AND (SELECT COUNT(DISTINCT endpoint) FROM dart_filing_endpoint_checkpoints c WHERE c.receipt_no = dart_discovered_filings.receipt_no AND c.status = 'APPLIED') = 3`).run(symbol, year);
    this.sqlite.prepare(`DELETE FROM provider_input_issues WHERE symbol = ? AND business_year = ?
      AND id IN (SELECT 'dart-filing:' || f.identity FROM dart_discovered_filings f
        WHERE f.symbol = ? AND f.business_year = ? AND f.status != 'UNRESOLVED'
        AND EXISTS (SELECT 1 FROM dart_filing_endpoint_checkpoints c WHERE c.receipt_no = f.receipt_no
          AND c.endpoint = 'FINANCIAL_STATEMENT' AND c.status = 'APPLIED')
        AND EXISTS (SELECT 1 FROM dart_filing_endpoint_checkpoints c WHERE c.receipt_no = f.receipt_no
          AND c.endpoint = 'SHARE_STATUS' AND c.status = 'APPLIED')
        AND EXISTS (SELECT 1 FROM dart_filing_endpoint_checkpoints c WHERE c.receipt_no = f.receipt_no
          AND c.endpoint = 'ISSUANCE_STATUS' AND c.status = 'APPLIED'))`).run(symbol, year, symbol, year);
    })();
  }

  markPendingPublication(key: DartRawSnapshotKey, receiptNo: string, retryAfterMs: number): void {
    this.save(key, receiptNo, "PENDING_PUBLICATION", retryAfterMs);
  }

  private save(key: DartRawSnapshotKey, receiptNo: string, status: string, retryAfterMs: number | null): void {
    this.sqlite.prepare(`INSERT INTO dart_filing_endpoint_checkpoints
      (receipt_no, endpoint, fs_div, status, retry_after_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(receipt_no, endpoint, fs_div) DO UPDATE SET status = excluded.status,
      retry_after_ms = excluded.retry_after_ms`).run(receiptNo, key.endpoint, key.fsDiv, status, retryAfterMs);
  }
}
