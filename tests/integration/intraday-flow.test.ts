import fs from "node:fs/promises";
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
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-flow-")),
    database = openDatabase(":memory:");
  const store = new ParquetIntradayStore(dir);
  const service = new IntradayService({
    db: database.db,
    store,
    source: { fetch },
    now: () => now,
    calendar: { classify: () => ({ state: "OPEN" }) },
    execute: executeIntraday,
    search: async () => [{ symbol: "005930", name: "삼성전자" }],
  });
  const app = Fastify();
  registerIntradayRoutes(app, service, async (req, reply) => {
    if (!req.headers.authorization) {
      await reply.code(401).send({ error: "인증 필요" });
      return;
    }
    req.authUser = { id: req.headers.authorization, username: "tester" };
  });
  cleanups.push(async () => {
    await service.close();
    await app.close();
    database.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, service, database, store };
}
const headers = { authorization: "owner" };
describe("분봉 준비부터 격리 계산과 저장까지", () => {
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
    const { service } = await fixture(source);
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
    expect(service.cancelRun("owner", run.id).status).toBe("CANCELLED");
    release(bars);
    await service.close();
    expect(service.getRun("owner", run.id)).toMatchObject({
      status: "CANCELLED",
    });
    expect(service.getRun("owner", run.id).result).toBeUndefined();
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
