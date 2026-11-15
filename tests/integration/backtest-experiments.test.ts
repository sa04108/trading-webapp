import { describe, expect } from "vitest";
import { authenticatedTest as it } from "../helpers/test-fixtures.js";
import { backtestJobs } from "../../src/runtime/shared/db/operations-schema.js";
import { backtestMetrics } from "../../src/server/shared/db/backtest-result-schema.js";
import { backtestCloneBatches, backtestCloneBatchItems } from "../../src/server/shared/db/backtest-batch-schema.js";
import { backtestValidations, backtestValidationTrials } from "../../src/server/shared/db/backtest-validation-schema.js";
import { backtestLineage, historyExtras } from "../../src/server/modules/backtest/presentation/backtest-experiment-routes.js";
import type { DatabaseHandle } from "../../src/runtime/shared/db/database.js";

function fixtures(database: DatabaseHandle) {
  const db = database.db;
  const job = (id: string, value: number | null = null, extra: Partial<typeof backtestJobs.$inferInsert> = {}) => {
    db.insert(backtestJobs).values({ id, strategyId: "range-breakout", status: "COMPLETED", requestJson: "{}", universeRuleJson: "{}", universeScheduleJson: "[]", createdAtMs: 1, ...extra }).run();
    if (value !== null) db.insert(backtestMetrics).values({ jobId: id, totalReturnPct: value, maxDrawdownPct: -5, tradeCount: 1, metricsJson: "{}" }).run();
  };
  const validation = (id: string, source: string, status = "COMPLETED", mode = "HOLDOUT") => db.insert(backtestValidations).values({ id, sourceJobId: source, status, configJson: JSON.stringify({ mode }), requestJson: "{}", planJson: "{}", strategyVersion: "1", strategySourceHash: "hash", engineVersion: "1", gitCommitSha: "sha", createdAtMs: 1 }).run();
  const trial = (parent: string, id: string, value: number | null, role = "OOS", fold = 0, status = "COMPLETED", candidate: number | null = null) => {
    job(id, value, { status });
    db.insert(backtestValidationTrials).values({ id: `trial-${id}`, validationId: parent, jobId: id, role, fold, candidate }).run();
  };
  const batch = (id: string, source: string, status = "COMPLETED") => db.insert(backtestCloneBatches).values({ id, sourceJobId: source, strategyId: "range-breakout", status, totalCount: 3, requestJson: "{}", universeScheduleJson: "[]", createdAtMs: 1 }).run();
  const seed = (parent: string, source: string, id: string, value: number, ordinal: number, status = "COMPLETED") => {
    job(id, value, { status, cloneSourceJobId: source, cloneBatchId: parent });
    db.insert(backtestCloneBatchItems).values({ id: `item-${id}`, batchId: parent, jobId: id, ordinal, randomSeed: ordinal + 42, state: "DISPATCHED" }).run();
  };
  return { job, validation, trial, batch, seed };
}

describe("백테스트 실험 요약과 결과 경로", () => {
  // 기존 이력 검사는 정렬만 확인한다. 부분 OOS·기준 전략이 요약을 왜곡하거나 원본 간 섞이는 경계를 검증한다.
  it("완료된 실험의 독립 OOS 평균을 집계하고 표본 수와 기록 수를 구분한다", async ({ ctx, cookie }) => {
    const database = ctx.container.database;
    const f = fixtures(database);
    f.job("source", 25, { benchmarkJson: JSON.stringify({ benchmarkId: "KOSPI", name: "코스피", source: "KRX_OPEN_API", sourceVersion: "v1", period: { from: "2020-01-01", to: "2021-01-01" }, covered: true, points: [{ date: "2020-01-01", close: 100 }, { date: "2021-01-01", close: 110 }] }) });
    f.job("other");
    f.batch("batch", "source");
    f.seed("batch", "source", "seed-1", 10, 0);
    f.seed("batch", "source", "seed-2", 30, 1);
    f.seed("batch", "source", "seed-failed", 999, 2, "FAILED");
    f.validation("holdout", "source"); f.trial("holdout", "oos1", 10);
    f.trial("holdout", "training", 900, "TRAIN");
    f.validation("walk", "source", "COMPLETED", "WALK_FORWARD");
    f.trial("walk", "oos2", 20, "OOS", 0); f.trial("walk", "oos3", 40, "OOS", 1);
    f.trial("walk", "baseline", 800, "BASELINE");
    f.validation("partial", "source", "FAILED"); f.trial("partial", "partial-oos", 900);
    f.validation("missing", "source"); f.trial("missing", "missing-metric", null);
    f.validation("other-validation", "other"); f.trial("other-validation", "other-oos", 700);
    const rowsBefore = database.sqlite.prepare("SELECT count(*) AS n FROM backtest_jobs").get();
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/backtests/history-extras?jobIds=source,other", cookies: { session: cookie } });
    expect(response.statusCode).toBe(200);
    const summaries = response.json().summaries;
    const source = summaries.find((s: { jobId: string }) => s.jobId === "source");
    expect(source.benchmarkExcessReturnPct).toBeCloseTo(15);
    expect(source.seed).toMatchObject({ batchCount: 1, activeCount: 0, completedCount: 2, returns: { count: 2, mean: 20 } });
    expect(source.seed.returns.sampleStdDev).toBeCloseTo(Math.sqrt(200));
    expect(source.validation).toMatchObject({ experimentCount: 4, completedCount: 3, returns: { count: 2, mean: 20 }, modes: { HOLDOUT: 3, OPTIMIZED_HOLDOUT: 0, WALK_FORWARD: 1 } });
    expect(source.validation.returns.sampleStdDev).toBeCloseTo(Math.sqrt(200));
    expect(summaries.find((s: { jobId: string }) => s.jobId === "other").validation.returns).toEqual({ count: 1, mean: 700, sampleStdDev: null });
    f.batch("active-batch", "source", "ACTIVE"); f.validation("active-validation", "source", "ACTIVE");
    expect(historyExtras(database, ["source"])[0]).toMatchObject({ seed: { activeCount: 1 }, validation: { activeCount: 1 } });
    expect(database.sqlite.prepare("SELECT count(*) AS n FROM backtest_jobs").get()).toEqual(rowsBefore);
  });

  // 경로는 화면 방문 기록으로 복원할 수 없으므로 중첩된 직접 URL·삭제·순환 관계를 DB 경계에서 확인한다.
  it("난수 자식의 기간검증까지 부모 경로와 회차·역할을 복원한다", async ({ ctx, cookie }) => {
    const database = ctx.container.database;
    const f = fixtures(database);
    f.job("original"); f.batch("batch", "original"); f.seed("batch", "original", "seed", 1, 0);
    f.validation("validation", "seed", "COMPLETED", "WALK_FORWARD");
    f.trial("validation", "candidate", 1, "TRAIN", 1, "COMPLETED", 2);
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/backtests/candidate/lineage", cookies: { session: cookie } });
    expect(response.statusCode).toBe(200);
    const lineage = response.json();
    expect(lineage).toMatchObject({ kind: "validation", complete: true, roleLabel: "2회차 · IS 학습 · 후보 3" });
    expect(lineage.items.map((i: { href: string }) => i.href)).toEqual(["/backtests", "/backtests/original", "/backtests/original/seeds", "/backtests/batches/batch", "/backtests/seed", "/backtests/seed/validations", "/backtests/validations/validation", "/backtests/candidate"]);
    expect(backtestLineage(database, "original")).toMatchObject({ kind: "original", roleLabel: "직접 실행", complete: true });
    f.job("orphan", null, { cloneSourceJobId: "deleted" });
    expect(backtestLineage(database, "orphan")).toMatchObject({ kind: "clone", complete: false });
    f.job("cycle-a", null, { cloneSourceJobId: "cycle-b" }); f.job("cycle-b", null, { cloneSourceJobId: "cycle-a" });
    expect(backtestLineage(database, "cycle-a")).toMatchObject({ complete: false });
    expect(backtestLineage(database, "missing")).toBeNull();
  });

  it("새 읽기 API의 인증과 조회 범위를 제한한다", async ({ ctx, cookie }) => {
    for (const path of ["/history-extras?jobIds=one", "/one/lineage"]) expect((await ctx.app.inject({ method: "GET", url: `/api/v1/backtests${path}` })).statusCode).toBe(401);
    for (const ids of ["", "one,,two", Array.from({ length: 101 }, (_, i) => String(i)).join(",")]) {
      expect((await ctx.app.inject({ method: "GET", url: `/api/v1/backtests/history-extras?jobIds=${ids}`, cookies: { session: cookie } })).statusCode).toBe(400);
    }
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/backtests/missing/lineage", cookies: { session: cookie } })).statusCode).toBe(404);
  });
});
