import { describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { authenticatedTest as it } from "../helpers/test-fixtures.js";
import { backtestJobs } from "../../src/runtime/shared/db/operations-schema.js";
import { backtestMetrics } from "../../src/server/shared/db/backtest-result-schema.js";
import { backtestCloneBatches } from "../../src/server/shared/db/backtest-batch-schema.js";
import {
  backtestValidations,
  backtestValidationTrials,
} from "../../src/server/shared/db/backtest-validation-schema.js";
import type { BacktestRequest } from "../../src/shared/schemas/backtest-request.js";

const request: BacktestRequest = {
  strategyId: "range-breakout",
  parameters: {},
  universeRule: {
    markets: ["KOSPI"],
    stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 10 }],
    rebalanceInterval: { value: 1, unit: "MONTH" },
  },
  period: { from: "2025-01-01", to: "2026-01-01" },
  capital: { initialCash: 10_000_000, currency: "KRW" },
  execution: {
    fillTiming: "NEXT_BAR_OPEN",
    commissionProfileId: "kr-equity-default",
    slippageProfileId: "fixed-5bps",
  },
  risk: { maxPositions: 5 },
  randomSeed: 42,
};

describe("백테스트 전체 이력 조회", () => {
  // 기존 큐 통합 검사는 최신순 목록만 확인하므로 오래된 고수익 기록의 정렬·페이지 경계를 검증한다.
  it("전체 전략 이력을 정렬·페이지화하며 내부 실험과 미완료 지표를 제외한다", async ({
    ctx,
    cookie,
  }) => {
    const db = ctx.container.database.db;
    const insert = (
      id: string,
      index: number,
      extra: Partial<typeof backtestJobs.$inferInsert> = {},
    ) => {
      db.insert(backtestJobs)
        .values({
          id,
          status: "COMPLETED",
          strategyId: request.strategyId,
          requestJson: JSON.stringify(request),
          universeRuleJson: JSON.stringify(request.universeRule),
          universeScheduleJson: "[]",
          createdAtMs: index + 100,
          ...extra,
        })
        .run();
    };
    for (let i = 0; i < 52; i++) {
      const id = `history-${String(i).padStart(2, "0")}`;
      insert(id, i, { status: i === 50 ? "FAILED" : "COMPLETED" });
      const totalReturnPct = i === 0 ? 200 : i;
      const cagrPct = i === 51 ? null : i;
      db.insert(backtestMetrics)
        .values({
          jobId: id,
          totalReturnPct,
          cagrPct,
          maxDrawdownPct: -5,
          tradeCount: 1,
          metricsJson: JSON.stringify({
            totalReturnPct,
            cagrPct,
            maxDrawdownPct: -5,
            tradeCount: 1,
          }),
        })
        .run();
    }
    insert("other-strategy", 60, { strategyId: "another-strategy" });
    insert("batch-child", 61, { cloneBatchId: "batch" });
    insert("validation-child", 62);
    db.insert(backtestValidations)
      .values({
        id: "validation",
        sourceJobId: "history-00",
        requestJson: "{}",
        configJson: "{}",
        planJson: "{}",
        strategyVersion: "1",
        strategySourceHash: "hash",
        engineVersion: "1",
        gitCommitSha: "sha",
        status: "COMPLETED",
        createdAtMs: 1,
      })
      .run();
    db.insert(backtestValidationTrials)
      .values({
        id: "trial",
        validationId: "validation",
        fold: 0,
        role: "TRAIN",
        jobId: "validation-child",
      })
      .run();
    const get = (suffix: string) =>
      ctx.app.inject({
        method: "GET",
        url: `/api/v1/backtests${suffix}`,
        cookies: { session: cookie },
      });
    expect((await get("/groups")).json()).toEqual({
      groups: [
        { strategyId: "another-strategy", total: 1 },
        { strategyId: request.strategyId, total: 52 },
      ],
    });
    const legacy = (await get("")).json();
    expect(legacy.jobs).toHaveLength(50);
    expect(legacy.total).toBe(53);
    expect(legacy.jobs.some((j: { id: string }) => j.id === "history-00")).toBe(
      false,
    );
    const query = `?strategyId=${request.strategyId}`;
    const sorted = (
      await get(`${query}&sort=returnPct&dir=desc&limit=2`)
    ).json();
    expect(sorted.total).toBe(52);
    expect(sorted.jobs.map((j: { id: string }) => j.id)).toEqual([
      "history-00",
      "history-51",
    ]);
    const ids: string[] = [];
    for (const offset of [0, 20, 40]) {
      const page = (
        await get(`${query}&sort=cagrPct&dir=asc&limit=20&offset=${offset}`)
      ).json();
      ids.push(...page.jobs.map((j: { id: string }) => j.id));
    }
    expect(new Set(ids).size).toBe(52);
    expect(ids.slice(0, 2)).toEqual(["history-00", "history-01"]);
    expect(ids.slice(-2)).toEqual(["history-51", "history-50"]);
    const tail = (
      await get(`${query}&sort=cagrPct&dir=desc&limit=2&offset=50`)
    ).json();
    expect(tail.jobs.map((j: { id: string }) => j.id)).toEqual([
      "history-51",
      "history-50",
    ]);
    expect(tail.jobs[1].metrics).toBeNull();
    expect((await get(`${query}&offset=100`)).json()).toEqual({
      jobs: [],
      total: 52,
    });
    expect((await get("?strategyId=missing")).json()).toEqual({
      jobs: [],
      total: 0,
    });
    for (const invalid of [
      "sort=anything",
      "dir=sideways",
      "limit=201",
      "offset=-1",
    ]) {
      expect((await get(`?${invalid}`)).statusCode).toBe(400);
    }
    expect(
      (await ctx.app.inject({ method: "GET", url: "/api/v1/backtests/groups" }))
        .statusCode,
    ).toBe(401);
  });

  it("종료일과 기간 길이를 구분하고 동률의 페이지 순서를 고정한다", async ({
    ctx,
    cookie,
  }) => {
    const records = [
      ["older-long", "2020-01-01", "2024-01-01"],
      ["newer-short-a", "2025-12-01", "2026-01-01"],
      ["newer-short-b", "2025-12-01", "2026-01-01"],
    ] as const;
    for (const [id, from, to] of records)
      ctx.container.database.db
        .insert(backtestJobs)
        .values({
          id,
          strategyId: request.strategyId,
          status: "COMPLETED",
          createdAtMs: 1,
          requestJson: JSON.stringify({ ...request, period: { from, to } }),
          universeRuleJson: JSON.stringify(request.universeRule),
          universeScheduleJson: "[]",
        })
        .run();
    const get = async (sort: string, offset = 0) =>
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/backtests?sort=${sort}&dir=desc&limit=1&offset=${offset}`,
          cookies: { session: cookie },
        })
      ).json().jobs[0].id;
    expect(await get("duration")).toBe("older-long");
    expect(await get("periodEnd")).toBe("newer-short-b");
    expect(await get("periodEnd", 1)).toBe("newer-short-a");
  });

  // 최신 100개 묶음 밖의 활성 실험도 원본 페이지에서 확인되어 삭제를 막아야 한다.
  it("화면에 있는 원본의 실험은 전역 100개 제한 없이 조회한다", async ({
    ctx,
    cookie,
  }) => {
    const db = ctx.container.database.db;
    for (const id of ["old-source", "new-source"])
      db.insert(backtestJobs)
        .values({
          id,
          strategyId: request.strategyId,
          status: "COMPLETED",
          createdAtMs: 1,
          requestJson: JSON.stringify(request),
          universeRuleJson: JSON.stringify(request.universeRule),
          universeScheduleJson: "[]",
        })
        .run();
    for (let i = 0; i < 101; i++)
      db.insert(backtestCloneBatches)
        .values({
          id: `batch-${i}`,
          sourceJobId: i === 0 ? "old-source" : "new-source",
          strategyId: request.strategyId,
          status: i === 0 ? "CANCELLING" : "COMPLETED",
          totalCount: 1,
          requestJson: JSON.stringify(request),
          universeScheduleJson: "[]",
          createdAtMs: i,
        })
        .run();
    const get = (suffix = "") =>
      ctx.app.inject({
        method: "GET",
        url: `/api/v1/backtest-clone-batches${suffix}`,
        cookies: { session: cookie },
      });
    expect((await get()).json().batches).toHaveLength(100);
    const filtered = (await get("?sourceJobIds=old-source")).json();
    expect(filtered.batches).toEqual([
      expect.objectContaining({
        id: "batch-0",
        sourceJobId: "old-source",
        status: "CANCELLING",
      }),
    ]);
    expect(filtered.sourceJobs.map((j: { id: string }) => j.id)).toEqual([
      "old-source",
    ]);
    expect(
      (await get("?sourceJobIds=old-source,new-source")).json().batches,
    ).toHaveLength(101);
    expect((await get("?sourceJobIds=missing")).json()).toEqual({
      batches: [],
      sourceJobs: [],
    });
    expect((await get("?sourceJobIds=")).statusCode).toBe(400);
    // 이전 버전에서 중첩 실험 원본이 된 자식도 정렬된 페이지를 통해 다시 접근할 수 있다.
    db.update(backtestJobs)
      .set({ cloneBatchId: "legacy-parent" })
      .where(eq(backtestJobs.id, "old-source"))
      .run();
    const history = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/backtests?strategyId=range-breakout",
      cookies: { session: cookie },
    });
    expect(history.json().jobs.map((j: { id: string }) => j.id)).toContain(
      "old-source",
    );
    expect(history.json().total).toBe(2);
  });
});
