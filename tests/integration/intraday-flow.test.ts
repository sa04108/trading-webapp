import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import {
  IntradayService,
  type IntradaySource,
} from "../../src/server/modules/intraday/application/intraday-service.js";
import { executeIntraday } from "../../src/server/modules/intraday/application/forked-intraday-engine.js";
import { ParquetIntradayStore } from "../../src/server/modules/intraday/infrastructure/parquet-intraday-store.js";
import { registerIntradayRoutes } from "../../src/server/modules/intraday/presentation/intraday-routes.js";
import { intradayCollections, intradayRuns } from "../../src/server/shared/db/intraday-schema.js";
import type {
  IntradayBar,
  IntradayRequest,
  IntradayRun,
} from "../../src/shared/schemas/intraday.js";

const date = "2026-11-12",
  now = Date.parse("2026-11-14T12:00:00+09:00");
const request: IntradayRequest = {
  mode: "intraday",
  strategyId: "intraday-ema",
  symbol: "005930",
  period: { from: date, to: date },
  timeframe: "1m",
  initialCash: 100_000,
  parameters: {
    fast: 2,
    slow: 3,
    allocationPct: 95,
    stopLossPct: 3,
    takeProfitPct: 6,
  },
  execution: {
    holdingPolicy: "DAY_ONLY",
    commissionBps: 1.5,
    taxBps: 20,
    slippageBps: 5,
    latencyMs: 1000,
    orderExpiryMinutes: 3,
    maxParticipationPct: 10,
  },
};
const bars: IntradayBar[] = Array.from({ length: 380 }, (_, i) => ({
  endMs: Date.parse(`${date}T09:00:00+09:00`) + (i + 1) * 60_000,
  open: i < 5 ? 1000 : 1010,
  high: i < 5 ? 1000 : 1010,
  low: i < 5 ? 1000 : 1010,
  close: i < 5 ? 1000 : 1010,
  volume: 1000,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(
  fetch: IntradaySource["fetch"] = async (_s, _f, _t, options) => {
    options?.onProgress?.({
      pages: 2,
      fetchedBars: bars.length,
      oldestEndMs: bars[0]!.endMs,
    });
    return bars;
  },
  options: { now?: number; closedDates?: string[]; onRecoveryFailure?: () => void; validateSymbol?: (symbol: string) => Promise<{ listDate: string; isinCode: string }> } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-flow-")),
    database = openDatabase(":memory:");
  const store = new ParquetIntradayStore(dir);
  const services: IntradayService[] = [];
  const makeService = (sourceFetch: IntradaySource["fetch"]) => {
    const instance = new IntradayService({
    db: database.db,
    store,
    source: { fetch: sourceFetch },
    onRecoveryFailure: options.onRecoveryFailure,
    validateSymbol: options.validateSymbol,
    now: () => options.now ?? now,
    calendar: { classify: (date) => ({ state: options.closedDates?.includes(date) ? "CLOSED" : "OPEN" }) },
    execute: executeIntraday,
    search: async () => [{ symbol: "005930", name: "삼성전자" }],
    });
    services.push(instance);
    return instance;
  };
  const service = makeService(fetch);
  const app = Fastify();
  registerIntradayRoutes(app, service, async (req, reply) => {
    if (!req.headers.authorization) {
      await reply.code(401).send({ error: "인증 필요" });
      return;
    }
    req.authUser = { id: req.headers.authorization, username: "tester" };
  });
  cleanups.push(async () => {
    for (const instance of services) await instance.close();
    await app.close();
    database.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, service, database, store, makeService };
}
const headers = { authorization: "owner" };
describe("분봉 준비부터 격리 계산과 저장까지", () => {
  // 기존 실행 흐름 검사는 100건 이후 이력과 목록 지표·정렬의 소유권 경계를 다루지 않는다.
  it("전체 이력의 지표를 정렬하고 결과 본문 없이 소유자별 페이지와 개수를 반환한다", async () => {
    const { app, database } = await fixture();
    for (let i = 0; i < 103; i++) {
      database.db.insert(intradayRuns).values({
        id: `history-${String(i).padStart(3, "0")}`, ownerId: i === 102 ? "other" : "owner",
        status: i === 100 ? "FAILED" : "COMPLETED", error: null,
        requestJson: JSON.stringify({ ...request, strategyId: i === 101 ? "intraday-orb" : request.strategyId }),
        createdAtMs: now + i, updatedAtMs: now + i,
        resultJson: JSON.stringify({ metrics: { returnPct: i === 0 ? 500 : i, maxDrawdownPct: -5 }, equity: [{ endMs: now, equity: 123 }] }),
      }).run();
    }
    const get = (query: string) => app.inject({ method: "GET", url: `/intraday/runs${query}`, headers });
    expect((await get("/groups")).json()).toEqual({ groups: [
      { strategyId: "intraday-ema", total: 101 },
      { strategyId: "intraday-orb", total: 1 },
    ] });
    const legacy = (await get("")).json();
    expect(legacy.runs).toHaveLength(100);
    expect(legacy.total).toBe(102);
    const query = "?strategyId=intraday-ema&sort=returnPct&dir=desc&limit=2";
    const first = (await get(query)).json();
    expect(first.total).toBe(101);
    expect(first.runs.map((r: { id: string }) => r.id)).toEqual(["history-000", "history-099"]);
    expect(first.runs[0].metrics).toEqual({ returnPct: 500, maxDrawdownPct: -5 });
    expect(first.runs[0]).not.toHaveProperty("result");
    for (const dir of ["asc", "desc"]) {
      const tail = (await get(`?strategyId=intraday-ema&sort=returnPct&dir=${dir}&limit=2&offset=100`)).json();
      expect(tail.runs).toEqual([expect.objectContaining({ id: "history-100", metrics: null })]);
    }
    expect((await get("?offset=200")).json()).toEqual({ runs: [], total: 102 });
    expect((await get("?sort=cagrPct")).statusCode).toBe(400);
    expect((await get("?limit=201")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/intraday/runs/groups" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/intraday/runs/groups", headers: { authorization: "other" } })).json())
      .toEqual({ groups: [{ strategyId: "intraday-ema", total: 1 }] });
  });

  // 이력 삭제는 인증·소유권과 실행 상태를 함께 검증하는 별도 경계다.
  it("종료된 소유자 이력만 삭제하고 공유 분봉 데이터는 보존한다", async () => {
    const { app, database, store } = await fixture();
    await store.merge("005930", bars, now);
    const ids = Object.fromEntries(["COMPLETED", "FAILED", "CANCELLED", "QUEUED", "PREPARING", "RUNNING"].map(status => [status, randomUUID()]));
    for (const [status, id] of Object.entries(ids)) {
      database.db.insert(intradayRuns).values({ id, ownerId: "owner", status, requestJson: JSON.stringify(request), resultJson: "invalid json", createdAtMs: now, updatedAtMs: now }).run();
    }
    const remove = (id: string, auth = headers) => app.inject({ method: "DELETE", url: `/intraday/history/${id}`, headers: auth });
    expect((await app.inject({ method: "DELETE", url: `/intraday/history/${ids.COMPLETED}` })).statusCode).toBe(401);
    expect((await remove(ids.COMPLETED!, { authorization: "other" })).statusCode).toBe(404);
    expect((await remove(randomUUID())).statusCode).toBe(404);
    expect((await remove("invalid")).statusCode).toBe(400);
    for (const status of ["QUEUED", "PREPARING", "RUNNING"]) expect((await remove(ids[status]!)).statusCode).toBe(409);
    for (const status of ["COMPLETED", "FAILED", "CANCELLED"]) {
      const response = await remove(ids[status]!);
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect((await remove(ids[status]!)).statusCode).toBe(404);
    }
    expect((await store.list())[0]?.symbol).toBe("005930");
  });

  // 기존 수집 흐름 검사는 저장된 분봉 재사용과 날짜별 요청 범위를 검증하지 않는다.
  it("완전한 날짜와 휴장일을 건너뛰고 누락 날짜별로 수집한 뒤 반복 수집을 생략한다", async () => {
    const dayBars = (day: string) => bars.map((bar) => ({
      ...bar, endMs: bar.endMs + (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)),
    }));
    const fetch = vi.fn<IntradaySource["fetch"]>(async (_symbol, from, _to, options) => {
      const day = new Date(from + 9 * 3_600_000).toISOString().slice(0, 10);
      const result = dayBars(day);
      options?.onProgress?.({ pages: 2, fetchedBars: result.length, oldestEndMs: result[0]!.endMs });
      return result;
    });
    const { service, store } = await fixture(fetch, { closedDates: ["2026-11-11"] });
    await store.merge("005930", dayBars("2026-11-10"), now);
    const period = { from: "2026-11-09", to: date };
    const first = service.collect("owner", { symbol: "005930", period });
    await vi.waitFor(() => expect(service.getCollection("owner", first.id).status).toBe("COMPLETED"));
    expect(fetch.mock.calls.map(([, from, to]) => [from, to])).toEqual(
      ["2026-11-09", date].map((day) => [Date.parse(`${day}T00:00:00+09:00`), Date.parse(`${day}T23:59:59.999+09:00`)]),
    );
    expect(service.getCollection("owner", first.id)).toMatchObject({ pages: 4, fetchedBars: 760 });
    const second = service.collect("owner", { symbol: "005930", period });
    await vi.waitFor(() => expect(service.getCollection("owner", second.id).status).toBe("COMPLETED"));
    expect(service.getCollection("owner", second.id)).toMatchObject({ pages: 0, fetchedBars: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("오늘의 미확정 분봉은 누락으로 수집하지 않는다", async () => {
    const today = "2026-11-14";
    const current = Date.parse(`${today}T09:03:00+09:00`);
    const fetch = vi.fn<IntradaySource["fetch"]>();
    const { service, store } = await fixture(fetch, { now: current });
    const available = bars.slice(0, 2).map((bar) => ({ ...bar, endMs: bar.endMs + 2 * 86_400_000 }));
    await store.merge("005930", available, current);
    const collection = service.collect("owner", { symbol: "005930", period: { from: today, to: today } });
    await vi.waitFor(() => expect(service.getCollection("owner", collection.id).status).toBe("COMPLETED"));
    expect(service.getCollection("owner", collection.id)).toMatchObject({ pages: 0, fetchedBars: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("나중 날짜 수집 실패 후 앞서 저장한 날짜를 재요청하지 않는다", async () => {
    let fail = true;
    const fetch = vi.fn<IntradaySource["fetch"]>(async (_symbol, from, _to, options) => {
      const day = new Date(from + 9 * 3_600_000).toISOString().slice(0, 10);
      if (day === date && fail) throw new Error("later day failed");
      const result = bars.map((bar) => ({ ...bar, endMs: bar.endMs + (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) }));
      options?.onProgress?.({ pages: 1, fetchedBars: result.length, oldestEndMs: result[0]!.endMs });
      return result;
    });
    const { service } = await fixture(fetch, { closedDates: ["2026-11-11"] });
    const period = { from: "2026-11-10", to: date };
    const first = service.collect("owner", { symbol: "005930", period });
    await vi.waitFor(() => expect(service.getCollection("owner", first.id).status).toBe("FAILED"));
    expect(service.getCollection("owner", first.id)).toMatchObject({ pages: 1, fetchedBars: 380, error: "later day failed" });
    fail = false;
    const retry = service.collect("owner", { symbol: "005930", period });
    await vi.waitFor(() => expect(service.getCollection("owner", retry.id).status).toBe("COMPLETED"));
    expect(fetch.mock.calls.map(([, from]) => from)).toEqual(["2026-11-10", date, date].map((day) => Date.parse(`${day}T00:00:00+09:00`)));
    expect(service.getCollection("owner", retry.id)).toMatchObject({ pages: 1, fetchedBars: 380 });
  });

  // 재시작은 중단한 수집의 식별자와 날짜별 영속화를 함께 보호한다.
  it("종료 후 수집을 같은 ID로 복구하고 이미 저장한 날짜를 재요청하지 않는다", async () => {
    const firstDay = bars.map((bar) => ({ ...bar, endMs: bar.endMs - 2 * 86_400_000 }));
    const initial = vi.fn<IntradaySource["fetch"]>(async (_symbol, from, _to, options) => {
      if (from === Date.parse("2026-11-10T00:00:00+09:00")) return firstDay;
      return new Promise<IntradayBar[]>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const { service, makeService } = await fixture(initial, { closedDates: ["2026-11-11"] });
    const collection = service.collect("owner", { symbol: "005930", period: { from: "2026-11-10", to: date } });
    await vi.waitFor(() => expect(initial).toHaveBeenCalledTimes(2));
    await service.close();
    expect(service.getCollection("owner", collection.id)).toMatchObject({ status: "QUEUED", error: null });
    const resumed = vi.fn<IntradaySource["fetch"]>(async () => bars);
    const restarted = makeService(resumed);
    await restarted.recover();
    await restarted.recover();
    await vi.waitFor(() => expect(restarted.getCollection("owner", collection.id).status).toBe("COMPLETED"));
    expect(resumed).toHaveBeenCalledOnce();
    expect(resumed.mock.calls[0]!.slice(0, 3)).toEqual(["005930", Date.parse(`${date}T00:00:00+09:00`), Date.parse(`${date}T23:59:59.999+09:00`)]);
  });

  it("사용자가 취소한 수집은 재시작해도 복구하지 않는다", async () => {
    const initial = vi.fn<IntradaySource["fetch"]>(async (_symbol, _from, _to, options) =>
      new Promise<IntradayBar[]>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );
    const { service, makeService } = await fixture(initial);
    const collection = service.collect("owner", { symbol: "005930", period: { from: date, to: date } });
    await vi.waitFor(() => expect(initial).toHaveBeenCalledOnce());
    service.cancelCollection("owner", collection.id);
    await service.close();
    const resumed = vi.fn<IntradaySource["fetch"]>(async () => bars);
    const restarted = makeService(resumed);
    await restarted.recover();
    expect(restarted.getCollection("owner", collection.id).status).toBe("CANCELLED");
    expect(resumed).not.toHaveBeenCalled();
  });

  it("잘못 저장된 복구 요청은 실패 처리하고 알림을 보낸다", async () => {
    const notify = vi.fn();
    const { service, database } = await fixture(undefined, { onRecoveryFailure: notify });
    database.db.insert(intradayCollections).values({
      id: "invalid-collection", ownerId: "owner", symbol: "005930", periodJson: "{",
      status: "RUNNING", createdAtMs: now, updatedAtMs: now,
    }).run();
    database.db.insert(intradayRuns).values({
      id: "expired-run", ownerId: "owner", status: "PREPARING",
      requestJson: JSON.stringify({ ...request, period: { from: "2024-01-01", to: "2024-01-01" } }),
      createdAtMs: now, updatedAtMs: now,
    }).run();
    service.recover();
    expect(service.getCollection("owner", "invalid-collection").status).toBe("FAILED");
    expect(service.getRun("owner", "expired-run").status).toBe("FAILED");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith();
  });

  it("복구한 백테스트는 기존 자식 수집을 사용하고 중복 생성하지 않는다", async () => {
    const fetch = vi.fn<IntradaySource["fetch"]>(async () => bars);
    const { service, database } = await fixture(fetch);
    database.db.insert(intradayRuns).values({
      id: "resumed-run", ownerId: "owner", status: "PREPARING", requestJson: JSON.stringify(request),
      createdAtMs: now, updatedAtMs: now,
    }).run();
    database.db.insert(intradayCollections).values({
      id: "resumed-child", ownerId: "owner", parentRunId: "resumed-run", symbol: "005930",
      periodJson: JSON.stringify(request.period), status: "RUNNING", createdAtMs: now, updatedAtMs: now,
    }).run();
    service.recover();
    await vi.waitFor(() => expect(service.getRun("owner", "resumed-run").status).toBe("COMPLETED"), { timeout: 15_000 });
    expect(service.getCollection("owner", "resumed-child").status).toBe("COMPLETED");
    expect(database.db.select().from(intradayCollections).all().map((row) => row.id)).toEqual(["resumed-child"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(service.getRun("owner", "resumed-run").result?.processedBars).toBe(380);
  });

  it("복구한 부모 실행을 준비 중 취소하면 자식 수집도 취소한다", async () => {
    let release!: (instrument: { listDate: string; isinCode: string }) => void;
    const pending = new Promise<{ listDate: string; isinCode: string }>((resolve) => { release = resolve; });
    const validateSymbol = vi.fn(() => pending);
    const fetch = vi.fn<IntradaySource["fetch"]>(async () => bars);
    const { service, database } = await fixture(fetch, { validateSymbol });
    database.db.insert(intradayRuns).values({
      id: "cancel-parent", ownerId: "owner", status: "PREPARING", requestJson: JSON.stringify(request),
      createdAtMs: now, updatedAtMs: now,
    }).run();
    database.db.insert(intradayCollections).values({
      id: "cancel-child", ownerId: "owner", parentRunId: "cancel-parent", symbol: "005930",
      periodJson: JSON.stringify(request.period), status: "QUEUED", createdAtMs: now, updatedAtMs: now,
    }).run();
    service.recover();
    await vi.waitFor(() => expect(validateSymbol).toHaveBeenCalled());
    service.cancelRun("owner", "cancel-parent");
    expect(service.getCollection("owner", "cancel-child").status).toBe("CANCELLED");
    release({ listDate: "2000-01-01", isinCode: "KR0000000000" });
    await service.close();
    expect(service.getRun("owner", "cancel-parent").status).toBe("CANCELLED");
    expect(service.getCollection("owner", "cancel-child").status).toBe("CANCELLED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("백테스트는 누락된 하루만 수집하고 병합된 전체 분봉으로 실행한다", async () => {
    const previous = bars.map((bar) => ({ ...bar, endMs: bar.endMs - 2 * 86_400_000 }));
    const fetch = vi.fn<IntradaySource["fetch"]>(async (_symbol, _from, _to, options) => {
      options?.onProgress?.({ pages: 1, fetchedBars: bars.length, oldestEndMs: bars[0]!.endMs });
      return bars;
    });
    const { service, store } = await fixture(fetch, { closedDates: ["2026-11-11"] });
    await store.merge("005930", [...previous, ...bars.filter((_, index) => index !== 10)], now);
    const run = service.submit("owner", { ...request, period: { from: "2026-11-10", to: date } });
    await vi.waitFor(() => expect(service.getRun("owner", run.id).status).toBe("COMPLETED"), { timeout: 15_000 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]!.slice(0, 3)).toEqual(["005930", Date.parse(`${date}T00:00:00+09:00`), Date.parse(`${date}T23:59:59.999+09:00`)]);
    expect(service.getRun("owner", run.id).result?.processedBars).toBe(760);
  });

  it("인증·소유권을 검증하고 실제 Parquet 수집 뒤 별도 프로세스 결과를 보존한다", async () => {
    const { app, service } = await fixture();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/intraday/runs",
          payload: request,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/intraday/runs",
          headers,
          payload: { ...request, mode: "daily" },
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: "/intraday/runs",
      headers,
      payload: request,
    });
    expect(response.statusCode).toBe(202);
    const id = response.json<IntradayRun>().id;
    await vi.waitFor(
      () => expect(service.getRun("owner", id).status).toBe("COMPLETED"),
      { timeout: 15_000 },
    );
    const output = service.getRun("owner", id);
    expect(output.result?.processedBars).toBe(380);
    expect(output.result?.fills.length).toBeGreaterThan(0);
    expect(output.result?.dataRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(output.result?.position.quantity).toBe(0);
    expect(service.listRuns("owner")[0]?.result).toBeUndefined();
    expect(
      (
        await app.inject({
          url: `/intraday/runs/${id}`,
          headers: { authorization: "other" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/intraday/runs/${id}`,
          headers: { authorization: "other" },
        })
      ).statusCode,
    ).toBe(404);
    const chart = await service.chart("005930", request.period, "5m");
    expect(chart.bars).toHaveLength(76);
    expect(chart.gaps).toEqual([]);
    expect((await service.overview("owner")).collections[0]?.status).toBe(
      "COMPLETED",
    );
  });
  it("수집 실패를 실행 실패로 종료하고 같은 결과 조회에 원인을 전달한다", async () => {
    const { service, app } = await fixture(async () => {
      throw new Error("토스 요청 실패 (429)");
    });
    const run = service.submit("owner", request);
    await vi.waitFor(() =>
      expect(service.getRun("owner", run.id).status).toBe("FAILED"),
    );
    const response = await app.inject({
      url: `/intraday/runs/${run.id}`,
      headers,
    });
    expect(response.json()).toMatchObject({
      status: "FAILED",
      error: "토스 요청 실패 (429)",
    });
    expect((await service.overview("owner")).collections[0]).toMatchObject({
      status: "FAILED",
      error: "토스 요청 실패 (429)",
    });
  });
  it("준비 취소 뒤 도착한 데이터는 실행하지 않으며 만료 기간은 거부한다", async () => {
    let release!: (value: IntradayBar[]) => void;
    const source = vi.fn(
      async () =>
        new Promise<IntradayBar[]>((resolve) => {
          release = resolve;
        }),
    );
    const { service, app, database } = await fixture(source);
    expect(() =>
      service.submit("owner", {
        ...request,
        period: { from: "2024-01-01", to: date },
      }),
    ).toThrow("365일");
    expect(() =>
      service.submit("owner", {
        ...request,
        period: { from: "2025-11-14", to: date },
      }),
    ).toThrow("하루 전체");
    const run = service.submit("owner", request);
    await vi.waitFor(() => expect(source).toHaveBeenCalledOnce());
    const child = database.db.select().from(intradayCollections).all()[0]!;
    expect(child.parentRunId).toBe(run.id);
    const cancel = await app.inject({ method: "DELETE", url: `/intraday/runs/${run.id}`, headers });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("CANCELLED");
    expect(service.getCollection("owner", child.id).status).toBe("CANCELLED");
    expect(service.pendingCancellationIds()).toEqual(expect.arrayContaining([run.id, child.id]));
    expect((await app.inject({ method: "DELETE", url: `/intraday/history/${run.id}`, headers })).statusCode).toBe(409);
    release(bars);
    await service.close();
    expect(service.pendingCancellationIds()).toEqual([]);
    expect(service.getRun("owner", run.id)).toMatchObject({
      status: "CANCELLED",
    });
    expect(service.getRun("owner", run.id).result).toBeUndefined();
    expect((await app.inject({ method: "DELETE", url: `/intraday/history/${run.id}`, headers })).statusCode).toBe(204);
  });
  it("가득 찬 실행 대기열도 내부 수집을 허용하고 취소한 대기 슬롯을 반환한다", async () => {
    let release!: (value: IntradayBar[]) => void;
    const source = vi.fn(
      async () =>
        new Promise<IntradayBar[]>((resolve) => {
          release = resolve;
        }),
    );
    const { service } = await fixture(source);
    const runs = Array.from({ length: 20 }, () =>
      service.submit("owner", request),
    );
    await vi.waitFor(() => expect(source).toHaveBeenCalledOnce());
    expect(service.getRun("owner", runs[0]!.id).status).toBe("PREPARING");
    for (const run of runs.slice(1)) service.cancelRun("owner", run.id);
    const replacement = service.submit("owner", request);
    expect(replacement.status).toBe("QUEUED");
    service.cancelRun("owner", replacement.id);
    service.cancelRun("owner", runs[0]!.id);
    release(bars);
    await service.close();
  });
});
