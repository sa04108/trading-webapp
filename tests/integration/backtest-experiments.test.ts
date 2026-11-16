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
    f.job("source", 25);
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
    expect(source).not.toHaveProperty('benchmarkExcessReturnPct');
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
    expect(backtestLineage(database, "original")).toMatchObject({ kind: "original", roleLabel: "결과", complete: true });
    f.job("orphan", null, { cloneSourceJobId: "deleted", cloneBatchId: "deleted-batch" });
    expect(backtestLineage(database, "orphan")).toMatchObject({ kind: "seed", complete: false });
    f.batch("cycle-batch-a", "cycle-b"); f.batch("cycle-batch-b", "cycle-a");
    f.seed("cycle-batch-a", "cycle-b", "cycle-a", 1, 0); f.seed("cycle-batch-b", "cycle-a", "cycle-b", 1, 0);
    expect(backtestLineage(database, "cycle-a")).toMatchObject({ kind: "seed", complete: false });
    expect(backtestLineage(database, "missing")).toBeNull();
  });

  // 기존 검사는 일반 복제의 출처까지 상위 결과로 해석했다. 기존 기록과 복제 이후 새 실험의 루트 경계를 검증한다.
  it("일반 복제는 원본의 종류나 삭제 여부와 관계없이 독립 결과이며 새 실험의 루트가 된다", async ({ ctx, cookie }) => {
    const database = ctx.container.database;
    const f = fixtures(database);
    f.job("source"); f.batch("source-seeds", "source"); f.seed("source-seeds", "source", "seed-child", 1, 0);
    f.validation("source-validation", "source"); f.trial("source-validation", "oos-child", 1);
    for (const [id, source] of [["same-clone", "source"], ["configured-clone", "source"], ["copy-of-seed", "seed-child"],
      ["copy-of-oos", "oos-child"], ["orphan-clone", "deleted"], ["clone-cycle-a", "clone-cycle-b"], ["clone-cycle-b", "clone-cycle-a"]] as const) {
      f.job(id, null, { cloneSourceJobId: source });
      const response = await ctx.app.inject({ method: "GET", url: `/api/v1/backtests/${id}/lineage`, cookies: { session: cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: "original", roleLabel: "결과", complete: true, items: [
        { label: "백테스트", href: "/backtests" },
        { label: `결과 ${id.slice(-6)}`, href: `/backtests/${id}`, description: id },
      ] });
    }
    f.batch("copy-seeds", "copy-of-seed"); f.seed("copy-seeds", "copy-of-seed", "new-seed", 1, 0);
    expect(backtestLineage(database, "new-seed")?.items.map((item) => item.href)).toEqual([
      "/backtests", "/backtests/copy-of-seed", "/backtests/copy-of-seed/seeds", "/backtests/batches/copy-seeds", "/backtests/new-seed",
    ]);
    f.validation("copy-validation", "copy-of-oos"); f.trial("copy-validation", "new-oos", 1);
    expect(backtestLineage(database, "new-oos")?.items.map((item) => item.href)).toEqual([
      "/backtests", "/backtests/copy-of-oos", "/backtests/copy-of-oos/validations", "/backtests/validations/copy-validation", "/backtests/new-oos",
    ]);
  });

  it("새 읽기 API의 인증과 조회 범위를 제한한다", async ({ ctx, cookie }) => {
    for (const path of ["/history-extras?jobIds=one", "/one/lineage"]) expect((await ctx.app.inject({ method: "GET", url: `/api/v1/backtests${path}` })).statusCode).toBe(401);
    for (const ids of ["", "one,,two", Array.from({ length: 101 }, (_, i) => String(i)).join(",")]) {
      expect((await ctx.app.inject({ method: "GET", url: `/api/v1/backtests/history-extras?jobIds=${ids}`, cookies: { session: cookie } })).statusCode).toBe(400);
    }
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/backtests/missing/lineage", cookies: { session: cookie } })).statusCode).toBe(404);
  });
});
