import { createHash } from "node:crypto";
import { describe, expect, vi } from "vitest";
import { authenticatedTest as it } from "../helpers/test-fixtures.js";
import { waitForCondition } from "../helpers/wait-for-condition.js";
import { AgentUniverseTasks } from "../../src/agent/universe-tasks.js";
import { runCryptoBacktest } from "../../src/runtime/modules/crypto/backtest.js";

const input = {
  markets: ["KRW-BTC"],
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  initialCash: 10_000,
  universeSize: 1,
  lookbackDays: 1,
  feeBps: 0,
  slippageBps: 0,
};
const bars = Array.from({ length: 33 }, (_, i) => {
  const price = i >= 30 ? 110 : 100;
  return {
    market: "KRW-BTC",
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: price,
    high: price,
    low: price,
    close: price,
    turnover: 1000,
  };
});

describe("원격 에이전트 암호화폐 백테스트", () => {
  it(
    "인증된 서버가 실제 에이전트에 작업을 배정하고 결과를 저장한다",
    { timeout: 60_000 },
    async ({ ctx, cookie }) => {
      const json = JSON.stringify(bars);
      const key = JSON.stringify(["upbit-krw-utc-day-v1", input.markets, "2026-01-02", input.endDate]);
      ctx.container.database.sqlite
        .prepare("INSERT INTO crypto_datasets(query_key,sha256,bars_json) VALUES(?,?,?)")
        .run(key, createHash("sha256").update(json).digest("hex"), json);
      const dispatch = vi.spyOn(AgentUniverseTasks.prototype, "start");
      try {
        await ctx.startAgent();
        const create = await ctx.app.inject({
          method: "POST",
          url: "/api/v1/crypto/backtests",
          cookies: { session: cookie },
          payload: input,
        });
        expect(create.statusCode).toBe(202);
        const { id } = create.json() as { id: string };
        const detail = await waitForCondition(
          () =>
            ctx.container.database.sqlite
              .prepare("SELECT status,executor,result_json,error FROM crypto_runs WHERE id=?")
              .get(id) as {
              status: string;
              executor: string | null;
              result_json: string | null;
              error: string | null;
            },
          (row) => row.status === "COMPLETED" || row.status === "FAILED",
          {
            signal: AbortSignal.timeout(45_000),
            timeoutMs: 40_000,
            intervalMs: 25,
            label: "원격 코인 백테스트",
          },
        );
        expect(detail).toMatchObject({ status: "COMPLETED", error: null });
        expect(detail.executor).toEqual(expect.any(String));
        expect(detail.executor).not.toBe("server-local");
        expect(JSON.parse(detail.result_json!)).toEqual(runCryptoBacktest(input, bars));
        expect(dispatch.mock.calls.some(([task]) => task.type === "CRYPTO_TASK" && task.taskId === id)).toBe(
          true,
        );
        const response = await ctx.app.inject({
          method: "GET",
          url: `/api/v1/crypto/backtests/${id}`,
          cookies: { session: cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().result).toEqual(runCryptoBacktest(input, bars));
        const settings = {
          method: "POST" as const,
          url: "/api/v1/crypto/paper/settings",
          cookies: { session: cookie },
          payload: { sourceRunId: id, initialCash: 20_000 },
        };
        const prepared = await ctx.app.inject(settings);
        expect(prepared.statusCode).toBe(200);
        expect(prepared.json().account).toMatchObject({
          sourceRunId: id,
          active: false,
          cash: 20_000,
          input,
          trades: [],
        });
        const activation = await ctx.app.inject({
          method: "POST",
          url: "/api/v1/crypto/paper/active",
          cookies: { session: cookie },
          payload: { active: true },
        });
        expect(activation.statusCode).toBe(200);
        expect(activation.json().account.active).toBe(true);
        expect((await ctx.app.inject(settings)).statusCode).toBe(409);
        const dashboard = await ctx.app.inject({
          method: "GET",
          url: "/api/v1/crypto/paper",
          cookies: { session: cookie },
        });
        expect(dashboard.json().account).toMatchObject({ active: true, cash: 20_000, sourceRunId: id });
        const account = activation.json().account;
        const version = {
          method: "POST" as const,
          url: "/api/v1/crypto/paper/version",
          cookies: { session: cookie },
          payload: { expectedRevision: account.revision, targetVersion: account.latestStrategyVersion },
        };
        expect((await ctx.app.inject(version)).statusCode).toBe(409);
        const off = await ctx.app.inject({
          method: "POST",
          url: "/api/v1/crypto/paper/active",
          cookies: { session: cookie },
          payload: { active: false },
        });
        expect((await ctx.app.inject(version)).statusCode).toBe(409);
        const confirmed = await ctx.app.inject({
          ...version,
          payload: { ...version.payload, expectedRevision: off.json().account.revision },
        });
        expect(confirmed.statusCode).toBe(200);
        expect(confirmed.json().account).toMatchObject({
          active: false,
          strategyVersion: account.latestStrategyVersion,
          sourceRunId: id,
        });
      } finally {
        dispatch.mockRestore();
      }
    },
  );
});
