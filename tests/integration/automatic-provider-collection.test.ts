import { expect, it, vi } from "vitest";
import { pino } from "pino";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { AgentDataQueue } from "../../src/server/modules/agents/application/agent-data-queue.js";
import { createKrxHistoricalUniverseSource } from "../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js";
import { SqliteKrxRawSnapshotStore } from "../../src/server/modules/market-data/infrastructure/krx/sqlite-krx-raw-snapshot-store.js";
import { SqliteProviderRequestPolicy, PROVIDER_RETRY_DELAY_MS } from "../../src/server/shared/provider-request-policy.js";
import { dailyFixture, krxEnvelope, krxJsonResponse } from "../helpers/krx-fixtures.js";

const logger = pino({ enabled: false });
const clock = { now: () => Date.now() };
const config = { baseUrl: "https://krx.test", apiKey: "fixture", approvalExpiry: null };

it("손상된 KRX 원문만 자동 복구하고 정상 날짜와 복구 후 원문은 재사용한다", async () => {
  const database = openDatabase(":memory:");
  const fetchImpl = vi.fn(async () => krxJsonResponse(krxEnvelope([dailyFixture()])));
  const source = createKrxHistoricalUniverseSource(config, clock, logger, {
    fetchImpl, sleep: async () => {}, rawSnapshotStore: new SqliteKrxRawSnapshotStore(database.db),
    requestPolicy: new SqliteProviderRequestPolicy(database.sqlite),
  });
  try {
    const expected = await source.fetchDailyTrades("KOSPI", "2026-08-01");
    await source.fetchDailyTrades("KOSPI", "2026-08-02");
    database.sqlite.prepare("UPDATE krx_raw_api_snapshots SET payload_json = '{}' WHERE bas_dd = '20260801'").run();
    expect(await source.fetchDailyTrades("KOSPI", "2026-08-01")).toEqual(expected);
    await source.fetchDailyTrades("KOSPI", "2026-08-02");
    await source.fetchDailyTrades("KOSPI", "2026-08-01");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(database.sqlite.prepare("SELECT status, attempts FROM provider_request_plans WHERE reason = 'SOURCE_RECOVERY'").all())
      .toEqual([{ status: "COMPLETED", attempts: 1 }]);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM krx_raw_api_snapshots WHERE bas_dd = '20260801'").get()).toEqual({ n: 2 });
  } finally { database.close(); }
});

it.each(["HTTP", "NETWORK", "BODY_NETWORK"])("%s 실패가 한도에 도달하면 재시작 뒤에도 대기하고 예약 시각에 자동 완료한다", async (failure) => {
  const database = openDatabase(":memory:");
  let now = Date.parse("2026-09-20T10:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    if (++calls <= 5) {
      if (failure === "NETWORK") throw new TypeError("fetch failed");
      if (failure === "BODY_NETWORK") return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError("terminated")); },
      }));
      return new Response("일시 오류", { status: 500 });
    }
    return krxJsonResponse(krxEnvelope([dailyFixture()]));
  });
  const ready = vi.fn();
  const makeQueue = () => {
    const source = createKrxHistoricalUniverseSource(config, clock, logger, {
      fetchImpl, sleep: async () => {}, rawSnapshotStore: new SqliteKrxRawSnapshotStore(database.db),
      requestPolicy: new SqliteProviderRequestPolicy(database.sqlite),
    });
    return new AgentDataQueue(database, { ensureLatest: async () => ({ version: 2 }) } as never,
      async () => { await source.fetchDailyTrades("KOSPI", "2026-08-01"); }, ready, logger);
  };
  let queue = makeQueue();
  const row = () => database.sqlite.prepare("SELECT status, attempts, next_attempt_at_ms FROM agent_data_requests").get() as {
    status: string; attempts: number; next_attempt_at_ms: number;
  };
  try {
    queue.request("PREPARATION", "job", 1, { kind: "MARKET", dates: ["2026-08-01"] });
    const episodes = failure === "HTTP" ? 1 : 5;
    for (let episode = 1; episode <= episodes; episode++) {
      queue.tick();
      await vi.waitFor(() => {
        expect(row().status).toBe("QUEUED");
        expect(calls).toBe(failure === "HTTP" ? 5 : episode);
        expect(row().next_attempt_at_ms).toBeGreaterThan(now);
      });
      expect(row().attempts).toBe(0);
      if (episode < episodes) now = row().next_attempt_at_ms;
    }
    expect(row()).toEqual({ status: "QUEUED", attempts: 0, next_attempt_at_ms: now + PROVIDER_RETRY_DELAY_MS });
    expect(calls).toBe(5);
    await queue.stop();
    queue = makeQueue();
    queue.recover();
    queue.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(5);
    now = row().next_attempt_at_ms;
    queue.tick();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith("PREPARATION", "job", undefined));
    expect(calls).toBe(6);
    expect(database.sqlite.prepare("SELECT status, attempts, retry_after_ms FROM provider_request_plans").get())
      .toEqual({ status: "COMPLETED", attempts: 6, retry_after_ms: null });
  } finally { await queue.stop(); vi.restoreAllMocks(); database.close(); }
});

it("KRX 게시 대기 원문의 네트워크 재시도 시각은 다시 조회해도 유지된다", async () => {
  const database = openDatabase(":memory:");
  const now = Date.parse("2026-09-20T10:00:00Z");
  const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
  const source = createKrxHistoricalUniverseSource(config, { now: () => now }, logger, {
    fetchImpl, sleep: async () => {},
    rawSnapshotStore: { get: () => ({ payload: krxEnvelope([]), fetchedAtMs: 1 }), put() {} },
    tradingCalendar: { classify: () => ({ state: "OPEN", evidence: "개장일 fixture" }) },
    requestPolicy: new SqliteProviderRequestPolicy(database.sqlite, () => now),
  });
  try {
    for (let i = 0; i < 2; i++) {
      await expect(source.fetchDailyTrades("KOSPI", "2026-08-01"))
        .rejects.toMatchObject({ reason: "RETRY_BACKOFF", retryAfterMs: now + 10_000 });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally { database.close(); }
});
