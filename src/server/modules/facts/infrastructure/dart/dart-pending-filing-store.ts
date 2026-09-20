import { kstDateOf } from "../../../../../runtime/modules/market-data/domain/kst-date.js";
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

/** 발견과 본문 반영을 접수번호·endpoint별로 분리해 한 소비자의 완료가 다른 소비자를 숨기지 않는다. */
export class SqliteDartPendingFilingStore implements DartPendingFilingStore {
  constructor(private readonly sqlite: Database.Database) {}

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

  /** 이번 목록의 보고서 메타데이터만 비교한다. 저장 원문 본문과 다른 연도는 읽지 않는다. */
  observeFilings(identities: readonly string[]): { symbol: string; year: number }[] {
    if (identities.length > 100) throw new Error("공시 목록은 한 페이지씩 처리해야 합니다");
    const affected = new Map<string, {symbol:string;year:number}>();
    for (const identity of new Set(identities)) {
      const filing = this.sqlite.prepare(`SELECT receipt_no, symbol, business_year, report_code, status
        FROM dart_discovered_filings WHERE identity = ?`).get(identity) as {
          receipt_no:string|null; symbol:string|null; business_year:number|null; report_code:string|null; status:string;
        } | undefined;
      if (!filing || filing.status === "APPLIED" || filing.status === "UNRESOLVED" ||
          filing.symbol === null || filing.business_year === null || filing.report_code === null || filing.receipt_no === null) continue;
      const state = this.sqlite.prepare(`SELECT covered_years_json, action_covered_years_json,
        financial_updated_at_ms, action_updated_at_ms FROM symbol_facts_state WHERE code = ?`).get(filing.symbol) as {
          covered_years_json:string; action_covered_years_json:string|null;
          financial_updated_at_ms:number|null; action_updated_at_ms:number|null;
        } | undefined;
      if (!state) continue;
      const covered = (value: string | null): boolean => {
        try { const years: unknown = JSON.parse(value ?? "[]"); return Array.isArray(years) && years.includes(filing.business_year); }
        catch { return false; }
      };
      if (!covered(state.covered_years_json) && !covered(state.action_covered_years_json)) continue;
      const issue = this.sqlite.prepare("SELECT 1 FROM provider_input_issues WHERE id = ?").get(`dart-filing:${identity}`);
      const metadata = this.sqlite.prepare(`SELECT receipt_no, fetched_at_ms FROM dart_raw_api_snapshots
        WHERE code = ? AND business_year = ? AND report_code = ?`).all(filing.symbol, filing.business_year, filing.report_code) as
          {receipt_no:string|null;fetched_at_ms:number}[];
      const after = (timestamp: number | null): boolean => timestamp !== null && timestamp > 0 &&
        filing.receipt_no!.slice(0, 8) > kstDateOf(timestamp).replaceAll("-", "");
      const newer = metadata.some((row) => row.receipt_no !== null ? row.receipt_no < filing.receipt_no! : after(row.fetched_at_ms)) ||
        (metadata.length === 0 && ((covered(state.covered_years_json) && after(state.financial_updated_at_ms)) ||
          (covered(state.action_covered_years_json) && after(state.action_updated_at_ms))));
      if (!issue && !newer) {
        // 과거 원문 메타데이터가 없어도 이미 수집된 값을 불신하거나 다시 파싱하지 않는다.
        this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'BASELINE_UNKNOWN' WHERE identity = ? AND status != 'BASELINE_UNKNOWN'").run(identity);
        continue;
      }
      this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'PENDING' WHERE identity = ? AND status != 'PENDING'").run(identity);
      this.sqlite.prepare(`INSERT OR IGNORE INTO provider_input_issues
        (id, symbol, business_year, report_code, reason, evidence) VALUES (?, ?, ?, ?, 'PENDING_FILING', ?)`)
        .run(`dart-filing:${identity}`, filing.symbol, filing.business_year, filing.report_code, filing.receipt_no);
      affected.set(`${filing.symbol}:${filing.business_year}`, {symbol:filing.symbol, year:filing.business_year});
    }
    return [...affected.values()];
  }

  /** 정상화 성공 후 모든 본문 endpoint가 같은 공시를 반영한 경우에만 입력 차단을 해제한다. */
  markNormalized(symbol: string, year: number, consumer: "ALL" | "FINANCIAL" | "ACTION" = "ALL"): void {
    if (consumer !== "ALL") return;
    this.sqlite.transaction(() => {
    this.sqlite.prepare(`UPDATE dart_discovered_filings SET status = 'APPLIED' WHERE symbol = ? AND business_year = ? AND status != 'UNRESOLVED' AND (SELECT COUNT(DISTINCT endpoint) FROM dart_filing_endpoint_checkpoints c WHERE c.receipt_no = dart_discovered_filings.receipt_no AND c.status = 'APPLIED') = 3`).run(symbol, year);
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
