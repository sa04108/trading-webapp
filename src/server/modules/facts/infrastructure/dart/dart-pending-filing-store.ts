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
  constructor(
    private readonly sqlite: Database.Database,
    private readonly requestVerification?: (receiptNo: string) => void,
  ) {}

  getExpectedCorpCode(symbol: string): string | null {
    const row = this.sqlite.prepare(`SELECT payload_json FROM dart_discovered_filings
      WHERE symbol = ? AND status NOT IN ('UNLISTED', 'UNLISTED_PARTIAL') ORDER BY receipt_no DESC LIMIT 1`).get(symbol) as {payload_json:string} | undefined;
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
      WHERE f.status NOT IN ('APPLIED', 'BASELINE_UNKNOWN', 'UNLISTED') AND f.symbol = ? AND f.business_year = ? AND f.report_code = ?
      AND (c.status IS NULL OR c.status != 'APPLIED')
      ORDER BY f.receipt_no DESC LIMIT 1`).get(key.endpoint, key.fsDiv, key.symbol, key.businessYear, key.reportCode) as {
        receipt_no: string; discovered_at_ms: number; status: "PENDING" | "UNRESOLVED" | "UNLISTED_PARTIAL"; retry_after_ms: number | null;
      } | undefined;
    return row === undefined ? null : {
      receiptNo: row.receipt_no, discoveredAtMs: row.discovered_at_ms,
      status: row.status === "UNLISTED_PARTIAL" ? "UNRESOLVED" : row.status,
      retryAfterMs: row.retry_after_ms,
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

  /** 미적용 접수는 해제하고 일부 반영된 접수는 근거를 보존한 채 차단한다. */
  markUnlistedReceipts(receipts: readonly string[]): string[] {
    const unique = [...new Set(receipts.filter((receipt) => /^\d{14}$/.test(receipt)))];
    if (unique.length === 0) return [];
    const marked = this.sqlite.transaction(() => {
      const placeholders = unique.map(() => "?").join(", ");
      // receipt_no 단독 인덱스가 없으므로 후보는 한 번만 훑고 이후에는 identity PK를 쓴다.
      const pending = this.sqlite.prepare(`SELECT identity, receipt_no FROM dart_discovered_filings
        WHERE status = 'PENDING' AND receipt_no IN (${placeholders})`)
        .all(...unique) as Array<{ identity: string; receipt_no: string }>;
      const applied = new Set((this.sqlite.prepare(`SELECT DISTINCT receipt_no FROM dart_filing_endpoint_checkpoints
        WHERE status = 'APPLIED' AND receipt_no IN (${placeholders})`)
        .all(...unique) as Array<{ receipt_no: string }>).map((row) => row.receipt_no));
      const byReceipt = new Map<string, string[]>();
      for (const row of pending) {
        const identities = byReceipt.get(row.receipt_no) ?? [];
        identities.push(row.identity);
        byReceipt.set(row.receipt_no, identities);
      }
      const unlist = this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'UNLISTED' WHERE identity = ? AND status = 'PENDING'");
      const markPartial = this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'UNLISTED_PARTIAL' WHERE identity = ? AND status = 'PENDING'");
      const clearPendingPublication = this.sqlite.prepare("DELETE FROM dart_filing_endpoint_checkpoints WHERE receipt_no = ? AND status = 'PENDING_PUBLICATION'");
      const deleteIssue = this.sqlite.prepare("DELETE FROM provider_input_issues WHERE id = ?");
      const partialIssue = this.sqlite.prepare(`INSERT INTO provider_input_issues
        (id, symbol, business_year, report_code, reason, evidence)
        SELECT ?, symbol, business_year, report_code, 'PENDING_FILING', ?
        FROM dart_discovered_filings WHERE identity = ?
        ON CONFLICT(id) DO UPDATE SET reason = 'PENDING_FILING', evidence = excluded.evidence`);
      const result: string[] = [];
      for (const receipt of unique) {
        const identities = byReceipt.get(receipt);
        if (identities === undefined) continue;
        const partial = applied.has(receipt);
        let changed = false;
        for (const identity of identities) {
          if ((partial ? markPartial : unlist).run(identity).changes > 0) changed = true;
        }
        if (!changed) continue;
        clearPendingPublication.run(receipt);
        for (const identity of identities) {
          if (partial) partialIssue.run(`dart-filing:${identity}`, `접수 ${receipt}: 현재 목록 미관측, 일부 원문 반영`, identity);
          else deleteIssue.run(`dart-filing:${identity}`);
        }
        result.push(receipt);
      }
      return result;
    });
    return marked();
  }

  /** 이번 목록의 보고서 메타데이터만 비교한다. 저장 원문 본문과 다른 연도는 읽지 않는다. */
  observeFilings(identities: readonly string[], reappearedReceipts?: string[]): { symbol: string; year: number }[] {
    if (identities.length > 100) throw new Error("공시 목록은 한 페이지씩 처리해야 합니다");
    const affected = new Map<string, {symbol:string;year:number}>();
    for (const identity of new Set(identities)) {
      const filing = this.sqlite.prepare(`SELECT receipt_no, symbol, business_year, report_code, status
        FROM dart_discovered_filings WHERE identity = ?`).get(identity) as {
          receipt_no:string|null; symbol:string|null; business_year:number|null; report_code:string|null; status:string;
        } | undefined;
      if (!filing || filing.status === "APPLIED" || filing.status === "UNRESOLVED" ||
          filing.symbol === null || filing.business_year === null || filing.report_code === null || filing.receipt_no === null) continue;
      const reappeared = filing.status === "UNLISTED" || filing.status === "UNLISTED_PARTIAL";
      if (reappeared) {
        // 목록에 다시 나타난 접수는 이전의 하루 대기를 버리고 원문을 다시 확인한다.
        this.sqlite.transaction(() => {
          this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'PENDING' WHERE identity = ?").run(identity);
          this.sqlite.prepare("DELETE FROM dart_filing_endpoint_checkpoints WHERE receipt_no = ? AND status = 'PENDING_PUBLICATION'").run(filing.receipt_no);
        })();
        reappearedReceipts?.push(filing.receipt_no);
      }
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
      if (!reappeared && !issue && !newer) {
        // 과거 원문 메타데이터가 없어도 이미 수집된 값을 불신하거나 다시 파싱하지 않는다.
        this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'BASELINE_UNKNOWN' WHERE identity = ? AND status != 'BASELINE_UNKNOWN'").run(identity);
        continue;
      }
      this.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'PENDING' WHERE identity = ? AND status != 'PENDING'").run(identity);
      this.sqlite.prepare(`INSERT OR IGNORE INTO provider_input_issues
        (id, symbol, business_year, report_code, reason, evidence) VALUES (?, ?, ?, ?, 'PENDING_FILING', ?)`)
        .run(`dart-filing:${identity}`, filing.symbol, filing.business_year, filing.report_code, filing.receipt_no);
      if (reappeared) this.sqlite.prepare(`UPDATE provider_input_issues SET reason = 'PENDING_FILING', evidence = ?
        WHERE id = ?`).run(filing.receipt_no, `dart-filing:${identity}`);
      affected.set(`${filing.symbol}:${filing.business_year}`, {symbol:filing.symbol, year:filing.business_year});
    }
    return [...affected.values()];
  }

  /** 정상화 성공 후 소비자가 반영한 범위만 해제하고 나머지는 계산 DB에도 남긴다. */
  markNormalized(symbol: string, year: number, consumer: "ALL" | "ACTION" = "ALL"): void {
    if (consumer === "ACTION") {
      // endpoint 체크포인트는 원문 확인일 뿐이다. 자본변동 저장·coverage가 끝난 뒤에만
      // 이 메서드가 호출되므로 재무 미반영만 남겨도 agent가 완료를 오판하지 않는다.
      this.sqlite.prepare(`UPDATE provider_input_issues SET reason = 'PENDING_FINANCIAL_FILING'
        WHERE symbol = ? AND business_year = ? AND reason = 'PENDING_FILING'
        AND id IN (SELECT 'dart-filing:' || f.identity FROM dart_discovered_filings f
          WHERE f.symbol = ? AND f.business_year = ? AND f.status NOT IN ('UNRESOLVED', 'UNLISTED_PARTIAL')
          AND EXISTS (SELECT 1 FROM dart_filing_endpoint_checkpoints c WHERE c.receipt_no = f.receipt_no
            AND c.endpoint = 'SHARE_STATUS' AND c.fs_div = 'NONE' AND c.status = 'APPLIED')
          AND EXISTS (SELECT 1 FROM dart_filing_endpoint_checkpoints c WHERE c.receipt_no = f.receipt_no
            AND c.endpoint = 'ISSUANCE_STATUS' AND c.fs_div = 'NONE' AND c.status = 'APPLIED'))`)
        .run(symbol, year, symbol, year);
      return;
    }
    this.sqlite.transaction(() => {
    this.sqlite.prepare(`UPDATE dart_discovered_filings SET status = 'APPLIED' WHERE symbol = ? AND business_year = ? AND status NOT IN ('UNRESOLVED', 'UNLISTED_PARTIAL') AND (SELECT COUNT(DISTINCT endpoint) FROM dart_filing_endpoint_checkpoints c WHERE c.receipt_no = dart_discovered_filings.receipt_no AND c.status = 'APPLIED') = 3`).run(symbol, year);
    this.sqlite.prepare(`DELETE FROM provider_input_issues WHERE symbol = ? AND business_year = ?
      AND id IN (SELECT 'dart-filing:' || f.identity FROM dart_discovered_filings f
        WHERE f.symbol = ? AND f.business_year = ? AND f.status NOT IN ('UNRESOLVED', 'UNLISTED_PARTIAL')
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
    try {
      this.requestVerification?.(receiptNo);
    } catch {
      // 검증 예약이 실패해도 저장한 게시 대기는 다음 예약 시각까지 유지한다.
    }
  }

  private save(key: DartRawSnapshotKey, receiptNo: string, status: string, retryAfterMs: number | null): void {
    this.sqlite.prepare(`INSERT INTO dart_filing_endpoint_checkpoints
      (receipt_no, endpoint, fs_div, status, retry_after_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(receipt_no, endpoint, fs_div) DO UPDATE SET status = excluded.status,
      retry_after_ms = excluded.retry_after_ms`).run(receiptNo, key.endpoint, key.fsDiv, status, retryAfterMs);
  }
}
