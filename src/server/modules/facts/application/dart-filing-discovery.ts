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
export const PREVIEW_FILING_REQUEST_LIMIT = 2;
export const PREVIEW_FILING_TIMEOUT_MS = 5_000;
export const FILING_CONTINUATION_DELAY_MS = 15 * 60_000;
function dateAt(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function shift(date: string, days: number): string { return dateAt(Date.parse(date) + days * DAY); }

/** 미리보기는 소량의 목록만 확인하고, 미완료 이력은 내부에서 나눠 이어받는다. */
export class DartFilingDiscovery {
  private running: Promise<void> | null = null;
  private activity: "PREVIEW" | "COLLECTION" | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly owner = randomUUID();
  constructor(private readonly options: {
    sqlite: Database.Database;
    fetchPage: ((from: string, to: string, page: number, beforeAttempt: () => void, signal: AbortSignal) => Promise<FilingPage>) | null;
    logger: Logger;
    now?: () => number;
    onFilingsStored?: (identities: readonly string[]) => void;
  }) {}

  freshness() {
    const sqlite = this.options.sqlite;
    const last = sqlite.prepare("SELECT completed_at_ms, to_date FROM dart_discovery_jobs WHERE status = 'COMPLETED' ORDER BY to_date DESC, completed_at_ms DESC LIMIT 1").get() as
      {completed_at_ms: number; to_date: string} | undefined;
    const pending = sqlite.prepare("SELECT error FROM dart_discovery_jobs WHERE status != 'COMPLETED' ORDER BY rowid DESC LIMIT 1").get() as {error:string|null} | undefined;
    const uncertain = sqlite.prepare("SELECT 1 FROM dart_discovered_filings WHERE status IN ('BASELINE_UNKNOWN', 'UNRESOLVED') LIMIT 1").get();
    const today = dateAt(this.now() + 9 * 3600_000);
    return {
      lastCheckedAtMs: last?.completed_at_ms ?? null, checkedThrough: last?.to_date ?? null,
      warning: pending ? "공시 목록 일부 미확인: 기존 DB로 진행하며 나머지는 내부에서 이어서 확인합니다."
        : uncertain ? "일부 공시의 기존 자료 반영 여부 미확인"
          : last?.to_date === today ? null : last ? "최신 공시 확인 미완료" : "공시 확인 이력 없음",
      pending: pending !== undefined,
      collecting: this.activity === "COLLECTION",
    };
  }

  refresh(): Promise<void> {
    // 별도 수집의 긴 작업을 새 미리보기의 선행 조건으로 만들지 않는다.
    if (this.activity === "COLLECTION") return Promise.resolve();
    return this.start("PREVIEW");
  }

  collectPending(): Promise<void> {
    if (this.continuationTimer !== null) clearTimeout(this.continuationTimer);
    this.continuationTimer = null;
    if (this.activity === "PREVIEW") return this.running!.then(() => this.collectPending());
    return this.start("COLLECTION");
  }

  private start(activity: "PREVIEW" | "COLLECTION"): Promise<void> {
    if (this.stopped || !this.options.fetchPage) return Promise.resolve();
    if (this.running) return this.running;
    this.activity = activity;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error("공시 목록 확인 시간 초과")),
      activity === "PREVIEW" ? PREVIEW_FILING_TIMEOUT_MS : 30_000);
    this.running = this.run(activity, controller.signal).catch((error: unknown) => {
      this.options.logger.warn({ err: error, event: "dart.discovery.failed" }, "공시 목록 미확인: 기존 DB를 사용합니다");
    }).finally(() => {
      clearTimeout(timeout);
      this.controller = null;
      this.activity = null;
      this.running = null;
      this.scheduleContinuation(activity === "PREVIEW" ? 0 : FILING_CONTINUATION_DELAY_MS);
    });
    return this.running;
  }

  private scheduleContinuation(delay: number): void {
    if (this.stopped || this.continuationTimer !== null || !this.options.fetchPage) return;
    const pending = this.options.sqlite.prepare("SELECT 1 FROM dart_discovery_jobs WHERE status != 'COMPLETED' LIMIT 1").get();
    if (!pending) return;
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = null;
      void this.collectPending();
    }, delay);
    this.continuationTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.continuationTimer !== null) clearTimeout(this.continuationTimer);
    this.continuationTimer = null;
    this.controller?.abort(new Error("공시 목록 확인 종료"));
    await this.running;
  }
  private now(): number { return (this.options.now ?? Date.now)(); }

  private async run(activity: "PREVIEW" | "COLLECTION", signal: AbortSignal): Promise<void> {
    const sqlite = this.options.sqlite;
    const today = dateAt(this.now() + 9 * 3600_000);
    let attempts = 0;
    const limit = activity === "PREVIEW" ? PREVIEW_FILING_REQUEST_LIMIT : 100;
    const beforeAttempt = () => {
      signal.throwIfAborted();
      if (attempts >= limit) throw new Error("공시 목록 요청 한도 도달");
      attempts += 1;
    };
    let previewJob: DiscoveryJob | undefined;
    if (activity === "PREVIEW") {
      const last = sqlite.prepare("SELECT to_date FROM dart_discovery_jobs WHERE status = 'COMPLETED' ORDER BY to_date DESC, completed_at_ms DESC LIMIT 1").get() as {to_date:string} | undefined;
      const wantedFrom = shift(last?.to_date ?? today, -1);
      const from = wantedFrom < shift(today, -79) ? shift(today, -79) : wantedFrom;
      // 긴 공백은 별도 수집용 이력으로만 남긴다. 기존 DB를 훑어 최초 조회 범위를 만들지 않는다.
      if (wantedFrom < from) sqlite.prepare(`INSERT OR IGNORE INTO dart_discovery_jobs(day, from_date, to_date, page, status)
        VALUES (?, ?, ?, 1, 'DEFERRED')`).run(`backfill:${wantedFrom}:${from}`, wantedFrom, shift(from, -1));
      const id = `${today}:${randomUUID()}`;
      sqlite.prepare(`INSERT INTO dart_discovery_jobs(day, from_date, to_date, page, status) VALUES (?, ?, ?, 1, 'PENDING')`).run(id, from, today);
      previewJob = {day:id, from_date:from, to_date:today, page:1, status:"PENDING", owner:null, window_days:80};
    }
    while (!signal.aborted && attempts < limit) {
      const job = previewJob ?? sqlite.prepare(`SELECT * FROM dart_discovery_jobs WHERE status != 'COMPLETED'
        AND (owner IS NULL OR lease_until_ms < ?) ORDER BY rowid LIMIT 1`).get(this.now()) as DiscoveryJob | undefined;
      if (!job) return;
      const claimed = sqlite.prepare(`UPDATE dart_discovery_jobs SET owner = ?, lease_until_ms = ?, status = 'RUNNING'
        WHERE day = ? AND (owner IS NULL OR lease_until_ms < ?)`)
        .run(this.owner, this.now() + 60_000, job.day, this.now());
      if (!claimed.changes) return;
      const initialFrom = job.from_date;
      let from = initialFrom;
      let windowDays = job.window_days;
      const windowEnd = shift(from, windowDays - 1) < job.to_date ? shift(from, windowDays - 1) : job.to_date;
      const firstPage = job.page > 1 ? sqlite.prepare(`SELECT fetched_at_ms FROM dart_discovery_pages
        WHERE day = ? AND from_date = ? AND page = ?`).get(job.day, from, 1) as
        {fetched_at_ms:number} | undefined : undefined;
      // 같은 날의 내부 작업은 커서를 이어받아 분량 제한 때문에 앞부분만 반복하지 않는다.
      // 당시 열린 기간의 날짜가 바뀌었거나 저장 시점이 없으면 추가 접수를 확인하기 위해 다시 시작한다.
      const firstCheckedDay = firstPage === undefined ? null : dateAt(firstPage.fetched_at_ms + 9 * 3600_000);
      const restart = firstCheckedDay === null || (windowEnd >= firstCheckedDay && today > firstCheckedDay);
      let page = restart ? 1 : job.page;
      try {
        while (from <= job.to_date && attempts < limit) {
          signal.throwIfAborted();
          const to = shift(from, windowDays - 1) < job.to_date ? shift(from, windowDays - 1) : job.to_date;
          const requestedAtMs = this.now();
          const envelope = await this.fetchPage(from, to, page, beforeAttempt, signal);
          signal.throwIfAborted();
          if (envelope.status !== "000" && envelope.status !== "013") throw new Error(`DART 목록 오류: ${envelope.status}`);
          if (envelope.status === "000" && (!Array.isArray(envelope.list) || envelope.list.length > 100 ||
              !Number.isInteger(envelope.total_page) || envelope.total_page! < 1)) throw new Error("DART 목록 응답 형식 오류");
          const total = envelope.status === "013" ? 1 : envelope.total_page!;
          if (total > 1000) {
            if (windowDays === 1 || page !== 1) throw new Error("공시 일일 페이지 상한 초과");
            windowDays = Math.max(1, Math.floor(windowDays / 2));
            sqlite.prepare("UPDATE dart_discovery_jobs SET window_days = ? WHERE day = ?").run(windowDays, job.day);
            continue;
          }
          const nextFrom = page >= total ? shift(to, 1) : from;
          const nextPage = page >= total ? 1 : page + 1;
          sqlite.transaction(() => {
            const lease = sqlite.prepare("SELECT owner FROM dart_discovery_jobs WHERE day = ?").get(job.day) as {owner:string};
            if (lease.owner !== this.owner) throw new Error("공시 목록 수집 소유권 변경");
            sqlite.prepare(`INSERT INTO dart_discovery_pages(day, from_date, page, payload_json, fetched_at_ms) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(day, from_date, page) DO UPDATE SET payload_json = excluded.payload_json, fetched_at_ms = excluded.fetched_at_ms`)
              .run(job.day, from, page, JSON.stringify(envelope), requestedAtMs);
            const identities: string[] = [];
            for (const row of envelope.status === "013" ? [] : envelope.list ?? []) {
              const receipt = typeof row.rcept_no === "string" ? row.rcept_no : null;
              const symbol = typeof row.stock_code === "string" ? row.stock_code : null;
              const name = typeof row.report_nm === "string" ? row.report_nm : "";
              const period = /\((\d{4})\.(\d{2})\)/.exec(name);
              const reportCode = period && (
                (name.includes("사업보고서") && period[2] === "12") || (name.includes("반기보고서") && period[2] === "06") ||
                (name.includes("분기보고서") && ["03", "09"].includes(period[2]!))
              ) ? ({"03":"11013", "06":"11012", "09":"11014", "12":"11011"} as Record<string,string>)[period[2]!] : null;
              const identity = receipt ?? JSON.stringify(row);
              sqlite.prepare(`INSERT OR IGNORE INTO dart_discovered_filings
                (identity, receipt_no, symbol, business_year, report_code, payload_json, discovered_at_ms, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(identity, receipt, symbol, period ? Number(period[1]) : null,
                  reportCode ?? null, JSON.stringify(row), this.now(),
                  receipt && /^\d{14}$/.test(receipt) && symbol && /^\d{6}$/.test(symbol) && reportCode ? "PENDING" : "UNRESOLVED");
              identities.push(identity);
            }
            this.options.onFilingsStored?.(identities);
            sqlite.prepare("UPDATE dart_discovery_jobs SET from_date = ?, page = ?, lease_until_ms = ? WHERE day = ?")
              .run(nextFrom, nextPage, this.now() + 60_000, job.day);
          })();
          from = nextFrom; page = nextPage;
        }
        if (from <= job.to_date) throw new Error("공시 목록 요청 한도 도달: 나머지는 내부에서 이어서 확인합니다");
        sqlite.prepare("UPDATE dart_discovery_jobs SET status = 'COMPLETED', completed_at_ms = ?, owner = NULL, error = NULL WHERE day = ?")
          .run(this.now(), job.day);
        // 이번에 완전히 확인한 구간에 포함된 이전 실패 기록도 함께 닫는다.
        sqlite.prepare(`UPDATE dart_discovery_jobs SET status = 'COMPLETED', completed_at_ms = ?, error = NULL
          WHERE status != 'COMPLETED' AND owner IS NULL AND from_date >= ? AND to_date <= ?`)
          .run(this.now(), initialFrom, job.to_date);
      } catch (error) {
        sqlite.prepare("UPDATE dart_discovery_jobs SET status = 'DEFERRED', owner = NULL, error = ? WHERE day = ? AND owner = ?")
          .run(error instanceof Error ? error.message : String(error), job.day, this.owner);
        throw error;
      }
      if (activity === "PREVIEW") return;
    }
  }

  private async fetchPage(from: string, to: string, page: number, beforeAttempt: () => void, signal: AbortSignal): Promise<FilingPage> {
    // 공급자나 테스트 어댑터가 취소를 늦게 처리해도 미리보기의 대기 시간은 제한한다.
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, {once:true});
    });
    try {
      signal.throwIfAborted();
      return await Promise.race([this.options.fetchPage!(from, to, page, beforeAttempt, signal), cancelled]);
    } finally { signal.removeEventListener("abort", abort); }
  }
}
