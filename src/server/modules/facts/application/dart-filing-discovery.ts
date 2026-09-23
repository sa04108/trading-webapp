import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Logger } from "../../../shared/logger.js";

export interface FilingPage {
  readonly status: string;
  readonly total_page?: number;
  readonly total_count?: number;
  readonly page_no?: number;
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
  private readonly verificationReruns = new Set<string>();
  private readonly owner = randomUUID();
  constructor(private readonly options: {
    sqlite: Database.Database;
    fetchPage: ((from: string, to: string, page: number, beforeAttempt: () => void, signal: AbortSignal) => Promise<FilingPage>) | null;
    logger: Logger;
    now?: () => number;
    onFilingsStored?: (identities: readonly string[]) => readonly string[] | void;
    onMissingReceipts?: (receipts: readonly string[]) => readonly string[];
  }) {}
  private onUnlisted: ((receipts: readonly string[]) => void) | null = null;
  private onReappeared: ((receipts: readonly string[]) => void) | null = null;

  /** 목록에서 사라진 접수의 대기 작업은 DB 반영 뒤에만 깨운다. */
  setUnlistedListener(listener: (receipts: readonly string[]) => void): void { this.onUnlisted = listener; }
  /** 다시 목록에 나타난 접수는 저장 완료 뒤 차단된 작업을 다시 평가한다. */
  setReappearedListener(listener: (receipts: readonly string[]) => void): void { this.onReappeared = listener; }

  /** 본문 게시 대기에 들어간 접수일의 목록을 한 번 완전히 확인하도록 예약한다. */
  requestVerification(receiptNo: string): void {
    if (!/^\d{14}$/.test(receiptNo) || this.stopped || !this.options.fetchPage) return;
    const date = `${receiptNo.slice(0, 4)}-${receiptNo.slice(4, 6)}-${receiptNo.slice(6, 8)}`;
    const parsedDate = Date.parse(date);
    if (!Number.isFinite(parsedDate) || dateAt(parsedDate) !== date) return;
    const id = `verify:${date}`;
    const sqlite = this.options.sqlite;
    const current = sqlite.prepare("SELECT status FROM dart_discovery_jobs WHERE day = ?").get(id) as {status:string} | undefined;
    if (current?.status === "RUNNING") {
      this.verificationReruns.add(date);
      this.scheduleContinuation(0, true);
      return;
    }
    if (current?.status === "PENDING" || current?.status === "DEFERRED") {
      this.scheduleContinuation(0, true);
      return;
    }
    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM dart_discovery_pages WHERE day = ?").run(id);
      sqlite.prepare(`INSERT INTO dart_discovery_jobs(day, from_date, to_date, page, status, window_days)
        VALUES (?, ?, ?, 1, 'PENDING', 1)
        ON CONFLICT(day) DO UPDATE SET from_date = excluded.from_date, to_date = excluded.to_date,
        page = 1, status = 'PENDING', window_days = 1, owner = NULL, lease_until_ms = NULL,
        completed_at_ms = NULL, error = NULL`).run(id, date, date);
    })();
    this.scheduleContinuation(0, true);
  }

  /** 재시작 후 기존 게시 대기도 접수일별로 묶어 복원한다. */
  recoverPendingVerifications(): void {
    const rows = this.options.sqlite.prepare(`SELECT DISTINCT f.receipt_no FROM dart_discovered_filings f
      JOIN dart_filing_endpoint_checkpoints c ON c.receipt_no = f.receipt_no
      WHERE f.status = 'PENDING' AND c.status = 'PENDING_PUBLICATION'`).all() as {receipt_no:string}[];
    for (const row of rows) this.requestVerification(row.receipt_no);
  }

  freshness() {
    const sqlite = this.options.sqlite;
    const last = sqlite.prepare("SELECT completed_at_ms, to_date FROM dart_discovery_jobs WHERE status = 'COMPLETED' AND day NOT LIKE 'verify:%' ORDER BY to_date DESC, completed_at_ms DESC LIMIT 1").get() as
      {completed_at_ms: number; to_date: string} | undefined;
    const pending = sqlite.prepare("SELECT error FROM dart_discovery_jobs WHERE status != 'COMPLETED' ORDER BY rowid DESC LIMIT 1").get() as {error:string|null} | undefined;
    const uncertain = sqlite.prepare("SELECT 1 FROM dart_discovered_filings WHERE status IN ('BASELINE_UNKNOWN', 'UNRESOLVED', 'UNLISTED_PARTIAL') LIMIT 1").get();
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
    let failed = false;
    this.running = this.run(activity, controller.signal).catch((error: unknown) => {
      failed = true;
      this.options.logger.warn({ err: error, event: "dart.discovery.failed" }, "공시 목록 미확인: 기존 DB를 사용합니다");
    }).finally(() => {
      clearTimeout(timeout);
      this.controller = null;
      this.activity = null;
      this.running = null;
      const verifyPending = this.options.sqlite.prepare("SELECT 1 FROM dart_discovery_jobs WHERE day LIKE 'verify:%' AND status != 'COMPLETED' LIMIT 1").get();
      this.scheduleContinuation(activity === "PREVIEW" || (verifyPending && !failed) ? 0 : FILING_CONTINUATION_DELAY_MS);
    });
    return this.running;
  }

  private scheduleContinuation(delay: number, urgent = false): void {
    if (urgent && this.continuationTimer !== null) {
      clearTimeout(this.continuationTimer);
      this.continuationTimer = null;
    }
    if (this.stopped || this.continuationTimer !== null || !this.options.fetchPage || this.running) return;
    const pending = this.options.sqlite.prepare(`SELECT MIN(CASE WHEN owner IS NULL OR lease_until_ms IS NULL OR lease_until_ms < ? THEN 0
      ELSE lease_until_ms - ? + 1 END) AS due FROM dart_discovery_jobs WHERE status != 'COMPLETED'`)
      .get(this.now(), this.now()) as {due:number|null};
    if (pending.due === null) return;
    delay = Math.max(delay, pending.due);
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
      const last = sqlite.prepare("SELECT to_date FROM dart_discovery_jobs WHERE status = 'COMPLETED' AND day NOT LIKE 'verify:%' ORDER BY to_date DESC, completed_at_ms DESC LIMIT 1").get() as {to_date:string} | undefined;
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
        AND (owner IS NULL OR lease_until_ms IS NULL OR lease_until_ms < ?) ORDER BY CASE WHEN day LIKE 'verify:%' THEN 0 ELSE 1 END, rowid LIMIT 1`).get(this.now()) as DiscoveryJob | undefined;
      if (!job) return;
      const claimed = sqlite.prepare(`UPDATE dart_discovery_jobs SET owner = ?, lease_until_ms = ?, status = 'RUNNING'
        WHERE day = ? AND (owner IS NULL OR lease_until_ms IS NULL OR lease_until_ms < ?)`)
        .run(this.owner, this.now() + 60_000, job.day, this.now());
      if (!claimed.changes) return;
      const initialFrom = job.from_date;
      const verification = job.day.startsWith("verify:");
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
      const storedFirst = verification && page > 1 ? sqlite.prepare(`SELECT payload_json FROM dart_discovery_pages
        WHERE day = ? AND from_date = ? AND page = 1`).get(job.day, initialFrom) as {payload_json:string} | undefined : undefined;
      const storedTotal = storedFirst === undefined ? null : (() => {
        try {
          const envelope = JSON.parse(storedFirst.payload_json) as FilingPage;
          return envelope.status === "013" ? 1 : envelope.total_page ?? null;
        } catch { return null; }
      })();
      if (verification && page > 1 && storedTotal === null) page = 1;
      if (verification && storedTotal !== null && page > storedTotal) from = shift(job.to_date, 1);
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
          if (verification && envelope.status === "000" && (!Number.isInteger(envelope.total_count) || envelope.total_count! < 1 ||
              !Number.isInteger(envelope.page_no) || envelope.page_no !== page ||
              envelope.total_page !== Math.ceil(envelope.total_count! / 100) ||
              envelope.list!.length !== Math.min(100, envelope.total_count! - (page - 1) * 100) ||
              envelope.list!.some((row) => typeof row.rcept_no !== "string" || !/^\d{14}$/.test(row.rcept_no))))
            throw new Error("DART 목록 완전성 확인 실패");
          if (verification && envelope.status === "013" && page !== 1) throw new Error("DART 목록 페이지 변경");
          const total = envelope.status === "013" ? 1 : envelope.total_page!;
          if (total > 1000) {
            if (windowDays === 1 || page !== 1) throw new Error("공시 일일 페이지 상한 초과");
            windowDays = Math.max(1, Math.floor(windowDays / 2));
            sqlite.prepare("UPDATE dart_discovery_jobs SET window_days = ? WHERE day = ?").run(windowDays, job.day);
            continue;
          }
          const finalPage = page >= total;
          const nextFrom = finalPage && !verification ? shift(to, 1) : from;
          const nextPage = finalPage && !verification ? 1 : page + 1;
          let reappeared: readonly string[] = [];
          sqlite.transaction(() => {
            const lease = sqlite.prepare("SELECT owner FROM dart_discovery_jobs WHERE day = ?").get(job.day) as {owner:string};
            if (lease.owner !== this.owner) throw new Error("공시 목록 수집 소유권 변경");
            if (verification && page === 1) sqlite.prepare(`DELETE FROM dart_discovery_pages
              WHERE day = ? AND from_date = ? AND page > ?`).run(job.day, from, total);
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
            reappeared = this.options.onFilingsStored?.(identities) ?? [];
            sqlite.prepare("UPDATE dart_discovery_jobs SET from_date = ?, page = ?, lease_until_ms = ? WHERE day = ?")
              .run(nextFrom, nextPage, this.now() + 60_000, job.day);
          })();
          if (reappeared.length > 0) this.onReappeared?.(reappeared);
          from = finalPage && verification ? shift(to, 1) : nextFrom;
          page = nextPage;
        }
        if (from <= job.to_date) {
          if (verification && attempts >= limit) {
            sqlite.prepare("UPDATE dart_discovery_jobs SET status = 'DEFERRED', owner = NULL, error = NULL WHERE day = ? AND owner = ?")
              .run(job.day, this.owner);
            return;
          }
          throw new Error("공시 목록 요청 한도 도달: 나머지는 내부에서 이어서 확인합니다");
        }
        if (verification && !this.verificationReruns.has(initialFrom))
          await this.reconcileVerification(job.day, initialFrom, signal);
        sqlite.prepare("UPDATE dart_discovery_jobs SET status = 'COMPLETED', completed_at_ms = ?, owner = NULL, error = NULL WHERE day = ?")
          .run(this.now(), job.day);
        if (verification && this.verificationReruns.delete(initialFrom))
          this.requestVerification(`${initialFrom.replaceAll("-", "")}000000`);
        // 이번에 완전히 확인한 구간에 포함된 이전 실패 기록도 함께 닫는다.
        sqlite.prepare(`UPDATE dart_discovery_jobs SET status = 'COMPLETED', completed_at_ms = ?, error = NULL
          WHERE status != 'COMPLETED' AND day NOT LIKE 'verify:%' AND owner IS NULL AND from_date >= ? AND to_date <= ?`)
          .run(this.now(), initialFrom, job.to_date);
      } catch (error) {
        if (verification && !signal.aborted && error instanceof Error &&
            /^DART 목록 (?:응답 형식|완전성|페이지|빈 페이지|접수번호|전체 확인)/.test(error.message))
          sqlite.transaction(() => {
            sqlite.prepare("DELETE FROM dart_discovery_pages WHERE day = ?").run(job.day);
            sqlite.prepare("UPDATE dart_discovery_jobs SET from_date = ?, page = 1 WHERE day = ?").run(initialFrom, job.day);
          })();
        sqlite.prepare("UPDATE dart_discovery_jobs SET status = 'DEFERRED', owner = NULL, error = ? WHERE day = ? AND owner = ?")
          .run(error instanceof Error ? error.message : String(error), job.day, this.owner);
        throw error;
      }
      if (activity === "PREVIEW") return;
    }
  }

  private async reconcileVerification(jobId: string, date: string, signal: AbortSignal): Promise<void> {
    const sqlite = this.options.sqlite;
    const candidates = sqlite.prepare(`SELECT receipt_no FROM dart_discovered_filings WHERE status = 'PENDING'
      AND receipt_no LIKE ?`).all(`${date.replaceAll("-", "")}%`) as {receipt_no:string}[];
    const missing = new Set(candidates.map((row) => row.receipt_no));
    const seen = new Set<string>();
    if (!this.options.onMissingReceipts) throw new Error("공시 미관측 저장소가 연결되지 않았습니다");
    const readPage = sqlite.prepare(`SELECT payload_json FROM dart_discovery_pages
      WHERE day = ? AND from_date = ? AND page = ?`);
    const storedPages = sqlite.prepare(`SELECT MAX(page) AS count FROM dart_discovery_pages
      WHERE day = ? AND from_date = ?`).get(jobId, date) as {count:number|null};
    let page = 0;
    let expectedTotal: number | null = null;
    let expectedPages: number | null = null;
    let count = 0;
    for (let index = 1; index <= (storedPages.count ?? 0); index += 1) {
      signal.throwIfAborted();
      if (this.verificationReruns.has(date)) return;
      page += 1;
      const stored = readPage.get(jobId, date, index) as {payload_json:string} | undefined;
      if (!stored) throw new Error("DART 목록 페이지 누락");
      const envelope = JSON.parse(stored.payload_json) as FilingPage;
      if (envelope.status === "013") {
        if (page !== 1 || envelope.list?.length) throw new Error("DART 목록 빈 페이지 불일치");
        expectedTotal = 0; expectedPages = 1;
      } else {
        if (envelope.status !== "000" || !Array.isArray(envelope.list) ||
            !Number.isInteger(envelope.total_count) || !Number.isInteger(envelope.total_page) ||
            envelope.page_no !== page || envelope.total_count! < 1 ||
            envelope.total_page !== Math.ceil(envelope.total_count! / 100) ||
            (expectedTotal !== null && expectedTotal !== envelope.total_count) ||
            (expectedPages !== null && expectedPages !== envelope.total_page) ||
            envelope.list.length !== Math.min(100, envelope.total_count! - (page - 1) * 100))
          throw new Error("DART 목록 페이지 일관성 확인 실패");
        expectedTotal = envelope.total_count!; expectedPages = envelope.total_page!;
        for (const row of envelope.list) {
          if (typeof row.rcept_no !== "string" || !/^\d{14}$/.test(row.rcept_no))
            throw new Error("DART 목록 접수번호 형식 오류");
          if (seen.has(row.rcept_no)) throw new Error("DART 목록 접수번호 중복");
          seen.add(row.rcept_no);
          missing.delete(row.rcept_no);
        }
        count += envelope.list.length;
      }
      if (index % 10 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (expectedPages === null || page !== expectedPages || count !== expectedTotal)
      throw new Error("DART 목록 전체 확인 실패");
    const absent = [...missing];
    for (let offset = 0; offset < absent.length; offset += 50) {
      signal.throwIfAborted();
      if (this.verificationReruns.has(date)) return;
      const unlisted = this.options.onMissingReceipts(absent.slice(offset, offset + 50));
      this.onUnlisted?.(unlisted);
      await new Promise<void>((resolve) => setImmediate(resolve));
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
