import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Logger } from "../../../shared/logger.js";

export interface FilingPage {
  readonly status: string;
  readonly total_page?: number;
  readonly list?: readonly Record<string, unknown>[];
}
interface DiscoveryJob {
  day: string; from_date: string; to_date: string; page: number;
  owner: string | null; status: string; window_days: number;
}
const DAY = 86_400_000;
function dateAt(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function shift(date: string, days: number): string { return dateAt(Date.parse(date) + days * DAY); }

/** 공시 조회는 서버 일일 작업에서만 수행하고 페이지 저장 이후에만 cursor를 진행한다. */
export class DartFilingDiscovery {
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly owner = randomUUID();
  constructor(private readonly options: {
    sqlite: Database.Database;
    fetchPage: ((from: string, to: string, page: number, beforeAttempt: () => void) => Promise<FilingPage>) | null;
    logger: Logger;
    now?: () => number;
    hourKst?: number;
    onPageStored?: () => Promise<void>;
  }) {}

  freshness() {
    const last = this.options.sqlite.prepare("SELECT day, completed_at_ms, to_date FROM dart_discovery_jobs WHERE status = 'COMPLETED' ORDER BY day DESC LIMIT 1").get() as
      {day: string; completed_at_ms: number; to_date: string} | undefined;
    const today = dateAt(this.now() + 9 * 3600_000);
    const unknownLegacy = this.options.sqlite.prepare(`SELECT 1 FROM symbol_facts_state
      WHERE (covered_years_json != '[]' AND (financial_updated_at_ms IS NULL OR financial_updated_at_ms <= 0))
         OR (action_covered_years_json != '[]' AND (action_updated_at_ms IS NULL OR action_updated_at_ms <= 0)) LIMIT 1`).get();
    const baseline = this.options.sqlite.prepare("SELECT 1 FROM dart_discovered_filings WHERE status = 'BASELINE_UNKNOWN' LIMIT 1").get();
    return { lastCheckedAtMs: last?.completed_at_ms ?? null, checkedThrough: last?.to_date ?? null,
      warning: unknownLegacy ? "기존 수집 자료의 공시 확인 기준시각 미확인" : baseline ? "기존 원문이 없어 일부 공시의 반영 여부 미확인" : last?.day === today ? null : last ? "최신 공시 확인 미완료" : "공시 확인 이력 없음" };
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().catch((error: unknown) => {
      this.options.logger.warn({ err: error, event: "dart.discovery.failed" }, "공시 확인 미완료: 기존 검증 데이터는 경고와 함께 사용합니다");
    }).finally(() => { this.running = null; });
    return this.running;
  }
  async stop(): Promise<void> { this.stopped = true; await this.running; }
  private now(): number { return (this.options.now ?? Date.now)(); }

  private async run(): Promise<void> {
    await this.options.onPageStored?.();
    const fetchPage = this.options.fetchPage;
    const now = this.now();
    const kst = new Date(now + 9 * 3600_000);
    if (!fetchPage || kst.getUTCHours() < (this.options.hourKst ?? 6)) return;
    const today = dateAt(kst.getTime());
    const sqlite = this.options.sqlite;
    const job = sqlite.transaction(() => {
      const last = sqlite.prepare("SELECT to_date FROM dart_discovery_jobs WHERE status = 'COMPLETED' ORDER BY day DESC LIMIT 1").get() as {to_date: string} | undefined;
      // 완료된 과거 날짜 경계를 하루 겹친다. 당일 목록은 다음 일일 작업에서 확인한다.
      const end = shift(today, -1);
      const earliest = sqlite.prepare(`SELECT MIN(checked_at_ms) AS checked_at_ms FROM (
        SELECT financial_updated_at_ms AS checked_at_ms FROM symbol_facts_state WHERE covered_years_json != '[]'
        UNION ALL SELECT action_updated_at_ms FROM symbol_facts_state WHERE action_covered_years_json != '[]'
      ) WHERE checked_at_ms > 0`).get() as {checked_at_ms: number | null};
      const initialFrom = earliest.checked_at_ms == null ? shift(end, -79)
        : shift(dateAt(earliest.checked_at_ms + 9 * 3600_000), -1);
      const unfinished = sqlite.prepare("SELECT 1 FROM dart_discovery_jobs WHERE status != 'COMPLETED' LIMIT 1").get();
      if (!unfinished) sqlite.prepare(`INSERT OR IGNORE INTO dart_discovery_jobs(day, from_date, to_date, page, status)
        VALUES (?, ?, ?, 1, 'PENDING')`).run(today, last ? shift(last.to_date, -1) : initialFrom < end ? initialFrom : end, end);
      const row = sqlite.prepare("SELECT * FROM dart_discovery_jobs WHERE status != 'COMPLETED' ORDER BY day LIMIT 1").get() as DiscoveryJob | undefined;
      if (!row) return null;
      const claimed = sqlite.prepare("UPDATE dart_discovery_jobs SET owner = ?, lease_until_ms = ? WHERE day = ? AND (owner IS NULL OR lease_until_ms < ?)")
        .run(this.owner, now + 300_000, row.day, now);
      return claimed.changes ? row : null;
    }).immediate();
    if (!job) return;
    try {
      let from = job.from_date;
      let page = job.page;
      let windowDays = job.window_days;
      while (from <= job.to_date) {
        if (this.stopped) throw new Error("공시 확인 작업 종료");
        const to = shift(from, windowDays - 1) < job.to_date ? shift(from, windowDays - 1) : job.to_date;
        const envelope = await fetchPage(from, to, page, () => {
          if (this.stopped) throw new Error("공시 확인 작업 종료");
          const renewed = sqlite.prepare("UPDATE dart_discovery_jobs SET lease_until_ms = ? WHERE day = ? AND owner = ?")
            .run(this.now() + 300_000, job.day, this.owner);
          if (!renewed.changes) throw new Error("공시 확인 작업의 소유권이 변경됐습니다");
        });
        if (envelope.status !== "000" && envelope.status !== "013") throw new Error(`DART 목록 오류: ${envelope.status}`);
        if (envelope.status === "000" && (!Array.isArray(envelope.list) || !Number.isInteger(envelope.total_page) || envelope.total_page! < 1))
          throw new Error("DART 목록 응답 형식이 올바르지 않습니다");
        const total = envelope.status === "013" ? 1 : envelope.total_page!;
        if (total > 1000) {
          if (windowDays === 1 || page !== 1) throw new Error("공시 일일 페이지 상한을 확인해야 합니다");
          windowDays = Math.max(1, Math.floor(windowDays / 2));
          sqlite.prepare("UPDATE dart_discovery_jobs SET window_days = ? WHERE day = ? AND owner = ?")
            .run(windowDays, job.day, this.owner);
          continue;
        }
        const nextFrom = page >= total ? shift(to, 1) : from;
        const nextPage = page >= total ? 1 : page + 1;
        sqlite.transaction(() => {
          const lease = sqlite.prepare("SELECT owner FROM dart_discovery_jobs WHERE day = ?").get(job.day) as {owner: string};
          if (lease.owner !== this.owner) throw new Error("공시 확인 작업의 소유권이 변경됐습니다");
          sqlite.prepare("INSERT OR IGNORE INTO dart_discovery_pages(day, from_date, page, payload_json, fetched_at_ms) VALUES (?, ?, ?, ?, ?)")
            .run(job.day, from, page, JSON.stringify(envelope), this.now());
          for (const row of envelope.list ?? []) {
            const receipt = typeof row.rcept_no === "string" ? row.rcept_no : null;
            const symbol = typeof row.stock_code === "string" ? row.stock_code : null;
            const name = typeof row.report_nm === "string" ? row.report_nm : "";
            const period = /\((\d{4})\.(\d{2})\)/.exec(name);
            const reportCode = period && (
              (name.includes("사업보고서") && period[2] === "12") ||
              (name.includes("반기보고서") && period[2] === "06") ||
              (name.includes("분기보고서") && ["03", "09"].includes(period[2]!))
            ) ? ({"03":"11013", "06":"11012", "09":"11014", "12":"11011"} as Record<string,string>)[period[2]!] : null;
            // 해석 불가 행도 원문과 함께 남겨 전체 연도 재수집으로 확대하지 않는다.
            sqlite.prepare(`INSERT OR IGNORE INTO dart_discovered_filings
              (identity, receipt_no, symbol, business_year, report_code, payload_json, discovered_at_ms, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(receipt ?? JSON.stringify(row), receipt, symbol,
                period ? Number(period[1]) : null, reportCode ?? null, JSON.stringify(row), this.now(),
                receipt && /^\d{14}$/.test(receipt) && symbol && /^\d{6}$/.test(symbol) && reportCode ? "PENDING" : "UNRESOLVED");
          }
          sqlite.prepare("UPDATE dart_discovery_jobs SET from_date = ?, page = ?, lease_until_ms = ? WHERE day = ? AND owner = ?")
            .run(nextFrom, nextPage, this.now() + 300_000, job.day, this.owner);
        })();
        await this.options.onPageStored?.();
        from = nextFrom; page = nextPage;
      }
      sqlite.prepare("UPDATE dart_discovery_jobs SET status = 'COMPLETED', completed_at_ms = ?, owner = NULL, error = NULL WHERE day = ? AND owner = ?")
        .run(this.now(), job.day, this.owner);
    } catch (error) {
      sqlite.prepare("UPDATE dart_discovery_jobs SET owner = NULL, error = ? WHERE day = ? AND owner = ?")
        .run(error instanceof Error ? error.message : String(error), job.day, this.owner);
      throw error;
    }
  }
}
