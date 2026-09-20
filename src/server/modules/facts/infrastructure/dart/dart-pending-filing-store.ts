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

  /** 원문보다 새로운 공시만 입력을 차단하고 보고서 단위 재생 대상으로 돌려준다. */
  reconcileDiscoveredFilings(): { symbol: string; year: number }[] {
    const filings = this.sqlite.prepare(`SELECT identity, receipt_no, symbol, business_year, report_code, status, payload_json
      FROM dart_discovered_filings WHERE status != 'APPLIED'`).all() as {
        identity: string; receipt_no: string | null; symbol: string | null; business_year: number | null;
        report_code: string | null; status: string; payload_json: string;
      }[];
    const savedMapping = this.corpNamespace === undefined ? undefined : this.sqlite.prepare(
      "SELECT xml, content_hash FROM dart_corp_code_snapshot WHERE namespace = ?").get(this.corpNamespace) as {xml:string;content_hash:string} | undefined;
    const knownMapping = savedMapping !== undefined && createHash("sha256").update(savedMapping.xml).digest("hex") === savedMapping.content_hash
      ? parseCorpCodeXml(savedMapping.xml) : new Map<string,string>();
    const affected = new Map<string, { symbol: string; year: number }>();
    for (const filing of filings) {
      if (filing.symbol === null) continue;
      const collected = this.sqlite.prepare("SELECT covered_years_json, action_covered_years_json, financial_updated_at_ms, action_updated_at_ms FROM symbol_facts_state WHERE code = ?")
        .get(filing.symbol) as { covered_years_json: string; action_covered_years_json: string | null; financial_updated_at_ms: number | null; action_updated_at_ms: number | null } | undefined;
      if (collected === undefined) continue;
      const years = [...JSON.parse(collected.covered_years_json), ...JSON.parse(collected.action_covered_years_json ?? "[]")] as number[];
      let filingCorp: string | null = null;
      try {
        const payload = JSON.parse(filing.payload_json) as {corp_code?:unknown};
        if (typeof payload.corp_code === "string" && /^\d{8}$/.test(payload.corp_code)) filingCorp = payload.corp_code;
      } catch { /* 법인 식별자가 없는 옛 목록은 추측하여 채우지 않는다. */ }
      const knownCorps = new Set<string>();
      const mapped = knownMapping.get(filing.symbol);
      if (mapped !== undefined) knownCorps.add(mapped);
      // 법인 정체성은 보고서 연도와 무관하다. 새 연도 공시도 이미 보유한 모든 연도와 비교한다.
      const identityRows = this.sqlite.prepare("SELECT payload_json, content_hash FROM dart_raw_api_snapshots WHERE code = ?")
        .all(filing.symbol) as {payload_json:string;content_hash:string}[];
      for (const row of identityRows) {
        if (createHash("sha256").update(row.payload_json).digest("hex") !== row.content_hash) continue;
        try {
          const payload = JSON.parse(row.payload_json) as {list?:{corp_code?:unknown}[]};
          for (const entry of payload.list ?? []) if (typeof entry.corp_code === "string") knownCorps.add(entry.corp_code);
        } catch { /* 원문 손상은 아래의 별도 검증에서 처리한다. */ }
      }
      if (filingCorp !== null && [...knownCorps].some((corp) => corp !== filingCorp)) {
        this.sqlite.prepare(`INSERT OR IGNORE INTO provider_input_issues
          (id, symbol, business_year, report_code, reason, evidence) VALUES (?, ?, NULL, NULL, 'IDENTITY_CHANGED', ?)`)
          .run(`dart-identity:${filing.symbol}`, filing.symbol, `${[...knownCorps].join(",")} -> ${filingCorp}`);
        continue;
      }
      if (years.length === 0 || (filing.business_year !== null && !years.includes(filing.business_year))) continue;
      const rows = this.sqlite.prepare(`SELECT endpoint, payload_json, content_hash FROM dart_raw_api_snapshots
        WHERE code = ? AND business_year = ? AND report_code = ?`)
        .all(filing.symbol, filing.business_year, filing.report_code) as { endpoint: string; payload_json: string; content_hash: string }[];
      const existingIssue = this.sqlite.prepare("SELECT id FROM provider_input_issues WHERE id = ?").get(`dart-filing:${filing.identity}`);
      const receiptDay = filing.receipt_no?.slice(0, 8);
      const newerThanCheckpoint = receiptDay !== undefined && [
        [collected.covered_years_json, collected.financial_updated_at_ms],
        [collected.action_covered_years_json, collected.action_updated_at_ms],
      ].some(([covered, timestamp]) => typeof timestamp === "number" && timestamp > 0 &&
        (JSON.parse(String(covered ?? "[]")) as number[]).includes(filing.business_year ?? -1) &&
        receiptDay > kstDateOf(timestamp).replaceAll("-", ""));
      const earlierReceiptOrCorruption = rows.some((row) => {
        if (createHash("sha256").update(row.payload_json).digest("hex") !== row.content_hash) return true;
        try {
          const payload = JSON.parse(row.payload_json) as { list?: { rcept_no?: string }[] };
          return payload.list?.some((entry) => entry.rcept_no !== undefined &&
            entry.rcept_no < (filing.receipt_no ?? "")) === true;
        } catch { return true; }
      });
      if (existingIssue === undefined && filing.status !== "UNRESOLVED" && !newerThanCheckpoint && !earlierReceiptOrCorruption) {
        this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'BASELINE_UNKNOWN' WHERE identity = ?").run(filing.identity);
        continue;
      }
      if (filing.status === "BASELINE_UNKNOWN")
        this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'PENDING' WHERE identity = ?").run(filing.identity);
      if (existingIssue === undefined && filing.status !== "UNRESOLVED" &&
          ["FINANCIAL_STATEMENT", "SHARE_STATUS", "ISSUANCE_STATUS"].every((endpoint) => rows.some((row) => row.endpoint === endpoint)) && rows.every((row) => {
        try {
          if (createHash("sha256").update(row.payload_json).digest("hex") !== row.content_hash) return false;
          const payload = JSON.parse(row.payload_json) as { list?: { rcept_no?: string }[] };
          return payload.list?.some((entry) => (entry.rcept_no ?? "") >= (filing.receipt_no ?? "~")) === true;
        } catch { return false; }
      })) continue;
      this.sqlite.prepare(`INSERT OR IGNORE INTO provider_input_issues
        (id, symbol, business_year, report_code, reason, evidence) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`dart-filing:${filing.identity}`, filing.symbol, filing.business_year, filing.report_code,
          filing.status === "UNRESOLVED" ? "UNRESOLVED_FILING" : "PENDING_FILING", filing.receipt_no ?? filing.identity);
      if (filing.business_year !== null && filing.report_code !== null && filing.status !== "UNRESOLVED")
        affected.set(`${filing.symbol}:${filing.business_year}`, { symbol: filing.symbol, year: filing.business_year });
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
