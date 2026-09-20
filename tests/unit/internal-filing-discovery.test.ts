import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import {
  DartFilingDiscovery,
  FILING_CONTINUATION_DELAY_MS,
  PREVIEW_FILING_TIMEOUT_MS,
  type FilingPage,
} from "../../src/server/modules/facts/application/dart-filing-discovery.js";

const logger = { warn: vi.fn() } as never;
const START = Date.parse("2026-09-20T10:00:00Z");
const filing = (receipt: string) => ({ rcept_no: receipt, stock_code: "005930", report_nm: "반기보고서 (2026.06)" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("내부 공시 목록 연속 수집", () => {
  it("미리보기는 목록만 두 번 확인하고 raw 전체 이력을 읽지 않으며, 남은 페이지는 내부에서 이어 수집한다", async () => {
    vi.useFakeTimers();
    const database = openDatabase(":memory:");
    const queries: string[] = [];
    const prepare = database.sqlite.prepare.bind(database.sqlite);
    vi.spyOn(database.sqlite, "prepare").mockImplementation((sql: string) => {
      queries.push(sql);
      if (/SELECT[\s\S]*FROM (?:symbol_facts_state|dart_raw_api_snapshots|dart_corp_code_snapshot|facts)\b/i.test(sql))
        throw new Error("목록 확인 중 원문·계산 전체 조회 금지");
      return prepare(sql);
    });
    const pages: number[] = [];
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (from, to, page, beforeAttempt) => {
        beforeAttempt(); pages.push(page);
        expect([from, to]).toEqual(["2026-09-19", "2026-09-20"]);
        return { status: "000", total_page: 3, list: [filing(`2026092000000${page}`)] };
      },
    });
    try {
      await discovery.refresh();
      expect(pages).toEqual([1, 2]);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(pages).toEqual([1, 2, 3]);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM dart_discovered_filings").get()).toEqual({ n: 3 });
      expect(queries.some((sql) => sql.includes("MIN(checked_at_ms)"))).toBe(false);
    } finally { await discovery.stop(); database.close(); }
  });

  it("미리보기의 두 번 예산은 내부 재시도도 세고, 5초 뒤 늦은 응답을 저장하지 않는다", async () => {
    vi.useFakeTimers();
    const database = openDatabase(":memory:");
    let resolve!: (page: FilingPage) => void;
    let signal!: AbortSignal;
    let physical = 0;
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, _page, beforeAttempt, abort) => {
        beforeAttempt(); physical += 1; signal = abort;
        return new Promise<FilingPage>((complete) => { resolve = complete; });
      },
    });
    try {
      const pending = discovery.refresh();
      await vi.advanceTimersByTimeAsync(PREVIEW_FILING_TIMEOUT_MS);
      await pending;
      expect(physical).toBe(1);
      expect(signal.aborted).toBe(true);
      resolve({ status: "000", total_page: 1, list: [filing("20260920000001")] });
      await Promise.resolve();
      expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM dart_discovered_filings").get()).toEqual({ n: 0 });

      let attempts = 0;
      const retried = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
        fetchPage: async (_from, _to, _page, beforeAttempt) => {
          for (let retry = 0; retry < 3; retry += 1) { beforeAttempt(); attempts += 1; }
          return { status: "013" };
        },
      });
      await retried.refresh();
      expect(attempts).toBe(2);
      await retried.stop();
    } finally { await discovery.stop(); database.close(); }
  });

  it("동시 미리보기는 공유하고, 배경 수집은 새 미리보기를 기다리게 하지 않는다", async () => {
    const database = openDatabase(":memory:");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let background = false;
    let calls = 0;
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, page, beforeAttempt) => {
        beforeAttempt(); calls += 1;
        if (background) await gate;
        return { status: "000", total_page: 3, list: [filing(`2026092000000${page}`)] };
      },
    });
    try {
      const first = discovery.refresh();
      expect(discovery.refresh()).toBe(first);
      await first;
      expect(calls).toBe(2);
      background = true;
      const collection = discovery.collectPending();
      await tick();
      await expect(discovery.refresh()).resolves.toBeUndefined();
      release();
      await collection;
    } finally { release(); await discovery.stop(); database.close(); }
  });

  it("미리보기 뒤 내부 수집은 저장 cursor에서 이어 받고 100회 배치마다 15분 뒤 다음 범위를 완료한다", async () => {
    vi.useFakeTimers();
    const database = openDatabase(":memory:");
    const pages: number[] = [];
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, page, beforeAttempt) => {
        beforeAttempt(); pages.push(page);
        return { status: "000", total_page: 205, list: [] };
      },
    });
    try {
      await discovery.refresh();
      expect(pages).toEqual([1, 2]);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(pages).toHaveLength(102);
      expect(pages.slice(-2)).toEqual([101, 102]);
      await vi.advanceTimersByTimeAsync(FILING_CONTINUATION_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(pages).toHaveLength(202);
      expect(pages.slice(-2)).toEqual([201, 202]);
      await vi.advanceTimersByTimeAsync(FILING_CONTINUATION_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(pages).toHaveLength(205);
      expect(pages.slice(-3)).toEqual([203, 204, 205]);
      expect(database.sqlite.prepare("SELECT status FROM dart_discovery_jobs ORDER BY rowid DESC LIMIT 1").get()).toEqual({ status: "COMPLETED" });
    } finally { await discovery.stop(); database.close(); }
  });

  it("내부 수집은 30초에 중단하고 15분 대기 뒤 저장된 위치에서 자동 재개한다", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const database = openDatabase(":memory:");
    let calls = 0;
    let backgroundSignal!: AbortSignal;
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger,
      fetchPage: async (_from, _to, _page, beforeAttempt, signal) => {
        beforeAttempt(); calls += 1;
        if (calls <= 2) return { status: "000", total_page: 3, list: [] };
        if (calls === 3) {
          backgroundSignal = signal;
          return new Promise<FilingPage>(() => {});
        }
        return { status: "013" };
      },
    });
    try {
      await discovery.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(backgroundSignal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(FILING_CONTINUATION_DELAY_MS - 1);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(4);
      expect(discovery.freshness().pending).toBe(false);
    } finally { await discovery.stop(); database.close(); }
  });

  it("stop 뒤 예약된 내부 연속 수집은 더 호출하지 않는다", async () => {
    vi.useFakeTimers();
    const database = openDatabase(":memory:");
    let calls = 0;
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, _page, beforeAttempt) => {
        beforeAttempt(); calls += 1;
        return { status: "000", total_page: 3, list: [] };
      },
    });
    try {
      await discovery.refresh();
      expect(calls).toBe(2);
      await discovery.stop();
      await vi.advanceTimersByTimeAsync(FILING_CONTINUATION_DELAY_MS);
      expect(calls).toBe(2);
    } finally { database.close(); }
  });

  it("KST 자정 뒤 열린 날짜 cursor는 첫 페이지부터 다시 읽고, 닫힌 날짜 cursor는 이어 읽으며 최신 경계를 후퇴시키지 않는다", async () => {
    const database = openDatabase(":memory:");
    const now = Date.parse("2026-09-20T15:00:01Z");
    database.sqlite.prepare(`INSERT INTO dart_discovery_jobs(day,from_date,to_date,page,status,completed_at_ms)
      VALUES('recent','2026-09-20','2026-09-20',1,'COMPLETED',1),('open','2026-09-20','2026-09-20',3,'DEFERRED',NULL),('closed','2020-01-01','2020-01-01',3,'DEFERRED',NULL)`).run();
    database.sqlite.prepare("INSERT INTO dart_discovery_pages(day,from_date,page,payload_json,fetched_at_ms) VALUES('open','2026-09-20',1,'{}',?)").run(Date.parse("2026-09-20T14:59:59Z"));
    database.sqlite.prepare("INSERT INTO dart_discovery_pages(day,from_date,page,payload_json,fetched_at_ms) VALUES('open','2026-09-20',2,'{}',?)").run(Date.parse("2026-09-20T15:00:01Z"));
    database.sqlite.prepare("INSERT INTO dart_discovery_pages(day,from_date,page,payload_json,fetched_at_ms) VALUES('closed','2020-01-01',1,'{}',?)").run(Date.parse("2020-01-02T00:00:00Z"));
    const calls: Array<[string, number]> = [];
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => now,
      fetchPage: async (from, _to, page, beforeAttempt) => {
        beforeAttempt(); calls.push([from, page]);
        return { status: "013" };
      },
    });
    try {
      await discovery.collectPending();
      expect(calls).toEqual([["2026-09-20", 1], ["2020-01-01", 3]]);
      expect(discovery.freshness().checkedThrough).toBe("2026-09-20");
    } finally { await discovery.stop(); database.close(); }
  });
});
