import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import {
  DartFilingDiscovery,
  FILING_CONTINUATION_DELAY_MS,
  PREVIEW_FILING_TIMEOUT_MS,
  type FilingPage,
} from "../../src/server/modules/facts/application/dart-filing-discovery.js";
import { SqliteDartPendingFilingStore } from "../../src/server/modules/facts/infrastructure/dart/dart-pending-filing-store.js";

const logger = { warn: vi.fn() } as never;
const START = Date.parse("2026-09-20T10:00:00Z");
const filing = (receipt: string) => ({ rcept_no: receipt, stock_code: "005930", report_nm: "반기보고서 (2026.06)" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("내부 공시 목록 연속 수집", () => {
  it("접수일의 모든 페이지가 완전하면 미관측 접수만 50건씩 해제하고 게시 대기를 깨운다", async () => {
    const database = openDatabase(":memory:");
    const date = "2026-08-28";
    const missing = Array.from({ length: 1000 }, (_, index) => `20260828${String(index).padStart(6, "0")}`);
    const insert = database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES (?, ?, '005930', 2026, '11012', '{}', 1, 'PENDING')`);
    database.sqlite.transaction(() => { for (const receipt of missing) insert.run(receipt, receipt); })();
    const batches: number[] = [];
    const resumed: string[] = [];
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (from, to, page, beforeAttempt) => {
        beforeAttempt();
        expect([from, to, page]).toEqual([date, date, 1]);
        return { status: "013" };
      },
      onMissingReceipts: (receipts) => {
        batches.push(receipts.length);
        const update = database.sqlite.prepare("UPDATE dart_discovered_filings SET status = 'UNLISTED' WHERE receipt_no = ?");
        database.sqlite.transaction(() => { for (const receipt of receipts) update.run(receipt); })();
        return receipts;
      },
    });
    discovery.setUnlistedListener((receipts) => { resumed.push(...receipts); });
    try {
      discovery.requestVerification(missing[0]!);
      await discovery.collectPending();
      expect(batches).toEqual(Array(20).fill(50));
      expect(resumed).toHaveLength(1000);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM dart_discovered_filings WHERE status = 'UNLISTED'").get())
        .toEqual({ count: 1000 });
      expect(database.sqlite.prepare("SELECT status FROM dart_discovery_jobs WHERE day = ?").get(`verify:${date}`))
        .toEqual({ status: "COMPLETED" });
      expect(discovery.freshness().checkedThrough).toBeNull();
    } finally { await discovery.stop(); database.close(); }
  });

  it("중간 페이지 오류·건수 불일치에서는 접수를 해제하지 않고 다음 확인을 첫 페이지부터 시작한다", async () => {
    const database = openDatabase(":memory:");
    const receipt = "20260828001423";
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES (?, ?, '005930', 2026, '11012', '{}', 1, 'PENDING')`).run(receipt, receipt);
    const pages: number[] = [];
    const missing = vi.fn(() => [receipt]);
    let failSecond = true;
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, page, beforeAttempt) => {
        beforeAttempt(); pages.push(page);
        if (page === 2 && failSecond) return { status: "000", total_page: 2, total_count: 101, page_no: 2, list: [] };
        return { status: "000", total_page: 2, total_count: 101, page_no: page,
          list: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) =>
            filing(`20260828${String((page - 1) * 100 + i + 500000).padStart(6, "0")}`)) };
      },
      onMissingReceipts: missing,
    });
    try {
      discovery.requestVerification(receipt);
      await discovery.collectPending();
      expect(missing).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("SELECT status,page FROM dart_discovery_jobs WHERE day='verify:2026-08-28'").get())
        .toEqual({ status: "DEFERRED", page: 1 });
      failSecond = false;
      await discovery.collectPending();
      expect(pages).toEqual([1, 2, 1, 2]);
      expect(missing).toHaveBeenCalledWith([receipt]);
    } finally { await discovery.stop(); database.close(); }
  });

  it("목록이 조회 중 한 페이지로 줄어든 경우 첫 페이지부터 다시 확인한다", async () => {
    const database = openDatabase(":memory:");
    const receipt = "20260828001423";
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES (?, ?, '005930', 2026, '11012', '{}', 1, 'PENDING')`).run(receipt, receipt);
    const pages: number[] = [];
    const missing = vi.fn(() => [receipt]);
    let reduced = false;
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, page, beforeAttempt) => {
        beforeAttempt(); pages.push(page);
        if (page === 2) { reduced = true; return { status: "013" }; }
        const count = reduced ? 100 : 101;
        return { status: "000", total_page: reduced ? 1 : 2, total_count: count, page_no: 1,
          list: Array.from({ length: 100 }, (_, i) => filing(`20260828${String(500000 + i).padStart(6, "0")}`)) };
      }, onMissingReceipts: missing,
    });
    try {
      discovery.requestVerification(receipt);
      await discovery.collectPending();
      expect(pages).toEqual([1, 2]);
      expect(missing).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("SELECT page FROM dart_discovery_jobs WHERE day='verify:2026-08-28'").get())
        .toEqual({ page: 1 });
      await discovery.collectPending();
      expect(pages).toEqual([1, 2, 1]);
      expect(missing).toHaveBeenCalledWith([receipt]);
    } finally { await discovery.stop(); database.close(); }
  });

  it("목록에 접수가 존재하면 본문 대기를 유지하고 전체 검증 후에도 해제하지 않는다", async () => {
    const database = openDatabase(":memory:");
    const receipt = "20260828001423";
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES (?, ?, '005930', 2026, '11012', '{}', 1, 'PENDING')`).run(receipt, receipt);
    const missing = vi.fn(() => []);
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, page, beforeAttempt) => {
        beforeAttempt(); return { status: "000", total_page: 1, total_count: 1, page_no: page, list: [filing(receipt)] };
      }, onMissingReceipts: missing,
    });
    try {
      discovery.requestVerification(receipt);
      await discovery.collectPending();
      expect(missing).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("SELECT status FROM dart_discovered_filings WHERE receipt_no=?").get(receipt))
        .toEqual({ status: "PENDING" });
    } finally { await discovery.stop(); database.close(); }
  });

  it("마지막 페이지 저장 직후 재시작해도 접수일 커서에서 저장된 전체 목록을 판정한다", async () => {
    const database = openDatabase(":memory:");
    const receipt = "20260828001423";
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES (?, ?, '005930', 2026, '11012', '{}', 1, 'PENDING')`).run(receipt, receipt);
    database.sqlite.prepare(`INSERT INTO dart_discovery_jobs(day,from_date,to_date,page,status,window_days)
      VALUES('verify:2026-08-28','2026-08-28','2026-08-28',2,'DEFERRED',1)`).run();
    database.sqlite.prepare(`INSERT INTO dart_discovery_pages(day,from_date,page,payload_json,fetched_at_ms)
      VALUES('verify:2026-08-28','2026-08-28',1,?,?)`).run(JSON.stringify({ status: "013" }), START);
    const fetchPage = vi.fn();
    const onMissingReceipts = vi.fn(() => [receipt]);
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage, onMissingReceipts,
    });
    try {
      await discovery.collectPending();
      expect(fetchPage).not.toHaveBeenCalled();
      expect(onMissingReceipts).toHaveBeenCalledWith([receipt]);
      expect(database.sqlite.prepare("SELECT status FROM dart_discovery_jobs WHERE day='verify:2026-08-28'").get())
        .toEqual({ status: "COMPLETED" });
    } finally { await discovery.stop(); database.close(); }
  });

  it("페이지 사이 접수 중복은 총건수가 맞아도 불완전한 목록으로 처리한다", async () => {
    const database = openDatabase(":memory:");
    const receipt = "20260828001423";
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES (?, ?, '005930', 2026, '11012', '{}', 1, 'PENDING')`).run(receipt, receipt);
    const repeated = filing("20260828500000");
    const onMissingReceipts = vi.fn(() => [receipt]);
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, page, beforeAttempt) => {
        beforeAttempt();
        return { status: "000", total_page: 2, total_count: 101, page_no: page,
          list: page === 1 ? [repeated, ...Array.from({ length: 99 }, (_, i) => filing(`20260828${String(500001 + i).padStart(6, "0")}`))] : [repeated] };
      }, onMissingReceipts,
    });
    try {
      discovery.requestVerification(receipt);
      await discovery.collectPending();
      expect(onMissingReceipts).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("SELECT status,page FROM dart_discovery_jobs WHERE day='verify:2026-08-28'").get())
        .toEqual({ status: "DEFERRED", page: 1 });
    } finally { await discovery.stop(); database.close(); }
  });

  it("같은 접수일의 본문 대기가 조회 중 새로 들어오면 그 날짜를 다시 확인한 결과만 적용한다", async () => {
    const database = openDatabase(":memory:");
    const receipt = "20260828001423";
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES (?, ?, '005930', 2026, '11012', '{}', 1, 'PENDING')`).run(receipt, receipt);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: number[] = [];
    const onMissingReceipts = vi.fn(() => [receipt]);
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, page, beforeAttempt) => {
        beforeAttempt(); calls.push(page);
        if (calls.length === 1) await gate;
        return { status: "013" };
      }, onMissingReceipts,
    });
    try {
      discovery.requestVerification(receipt);
      const first = discovery.collectPending();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      discovery.requestVerification(receipt);
      release();
      await first;
      expect(calls).toEqual([1, 1]);
      expect(onMissingReceipts).toHaveBeenCalledTimes(1);
    } finally { release(); await discovery.stop(); database.close(); }
  });

  it("미관측 공시가 목록에 다시 나타나면 DB 상태를 복원한 뒤 차단 작업에 알린다", async () => {
    const database = openDatabase(":memory:");
    const receipt = "20260920001423";
    database.sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('005930','KR',1)");
    database.sqlite.exec("INSERT INTO symbol_facts_state(code,covered_years_json) VALUES('005930','[2026]')");
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES (?, ?, '005930', 2026, '11012', '{}', 1, 'UNLISTED_PARTIAL')`).run(receipt, receipt);
    const store = new SqliteDartPendingFilingStore(database.sqlite);
    const listener = vi.fn((receipts: readonly string[]) => {
      expect(receipts).toEqual([receipt]);
      expect(database.sqlite.prepare("SELECT status FROM dart_discovered_filings WHERE identity=?").get(receipt))
        .toEqual({ status: "PENDING" });
    });
    const discovery = new DartFilingDiscovery({ sqlite: database.sqlite, logger, now: () => START,
      fetchPage: async (_from, _to, page, beforeAttempt) => {
        beforeAttempt(); return { status: "000", total_page: 1, list: [filing(receipt)] };
      },
      onFilingsStored: (identities) => {
        const reappeared: string[] = [];
        store.observeFilings(identities, reappeared);
        return reappeared;
      },
    });
    discovery.setReappearedListener(listener);
    try {
      await discovery.refresh();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { await discovery.stop(); database.close(); }
  });

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
