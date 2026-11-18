import { describe, expect } from "vitest";
import { authenticatedTest as it } from "../helpers/test-fixtures.js";
import { backtestJobs } from "../../src/runtime/shared/db/operations-schema.js";
import { backtestMetrics } from "../../src/server/shared/db/backtest-result-schema.js";
import { backtestValidations, backtestValidationTrials } from "../../src/server/shared/db/backtest-validation-schema.js";
import { backtestLineage, historyExtras } from "../../src/server/modules/backtest/presentation/backtest-experiment-routes.js";
import type { DatabaseHandle } from "../../src/runtime/shared/db/database.js";
import { configurationSearches, configurationSearchItems } from "../../src/server/shared/db/configuration-search-schema.js";
import { intradayRuns } from "../../src/server/shared/db/intraday-schema.js";
import { intradayValidations, intradayValidationTrials } from "../../src/server/shared/db/intraday-validation-schema.js";
import { BacktestDeletionService } from "../../src/server/modules/backtest/application/backtest-deletion-service.js";

function fixtures(database: DatabaseHandle) {
  const db = database.db;
  const job = (id: string, value: number | null = null, extra: Partial<typeof backtestJobs.$inferInsert> = {}) => {
    db.insert(backtestJobs).values({ id, strategyId: "range-breakout", status: "COMPLETED", requestJson: "{}", universeRuleJson: "{}", universeScheduleJson: "[]", createdAtMs: 1, ...extra }).run();
    if (value !== null) db.insert(backtestMetrics).values({ jobId: id, totalReturnPct: value, maxDrawdownPct: -5, tradeCount: 1, metricsJson: "{}" }).run();
  };
  const validation = (id: string, source: string, status = "COMPLETED", mode = "HOLDOUT") => {
    const config = mode === "WALK_FORWARD" ? { mode, trainMonths: 3, testMonths: 1 } : { mode, splitDate: "2023-01-01",
      ...(mode === "OPTIMIZED_HOLDOUT" ? { optimization: { axes: [{ key: "window", values: [5, 20] }] } } : {}),
    };
    db.insert(backtestValidations).values({ id, sourceJobId: source, status, configJson: JSON.stringify(config), requestJson: "{}", planJson: "{}", strategyVersion: "1", strategySourceHash: "hash", engineVersion: "1", gitCommitSha: "sha", createdAtMs: 1 }).run();
  };
  const trial = (parent: string, id: string, value: number | null, role = "OOS", fold = 0, status = "COMPLETED", candidate: number | null = null) => {
    job(id, value, { status });
    db.insert(backtestValidationTrials).values({ id: `trial-${id}`, validationId: parent, jobId: id, role, fold, candidate }).run();
  };
  return { job, validation, trial };
}

describe("백테스트 실험 요약과 결과 경로", () => {
  // 기존 계보 검사는 읽기 전용이다. 혼합된 실험 그래프의 실제 삭제·중복 집계·소유권·롤백은 별도로 보호한다.
  for (const mode of ["daily", "intraday"] as const) {
    it(`${mode} 삭제 확인은 중첩 실험을 중복 없이 집계하고 함께 삭제한다`, async ({ ctx, cookie, admin }) => {
      const database = ctx.container.database, db = database.db, f = fixtures(database);
      const owner = (database.sqlite.prepare("SELECT id FROM users WHERE username=?").get(admin.username) as { id: string }).id;
      const job = (id: string) => mode === "daily" ? f.job(id, 10) : db.insert(intradayRuns).values({ id, ownerId: owner, requestJson: "{}", status: "COMPLETED", createdAtMs: 1, updatedAtMs: 1 }).run();
      for (const id of ["source", "search-child", "validation-child", "independent"]) job(id);
      db.insert(configurationSearches).values({ id: "search", ownerId: owner, requestId: "request", mode, sourceJobId: "source", configJson: "{}", catalogJson: "{}", runtimeIdentity: "v1", status: "COMPLETED", notifiedAtMs: 1, createdAtMs: 1 }).run();
      db.insert(configurationSearchItems).values({ id: "item", searchId: "search", ordinal: 0, requestJson: "{}", valuesJson: "{}", status: "COMPLETED", jobId: "search-child" }).run();
      if (mode === "daily") {
        f.validation("validation", "search-child");
        db.insert(backtestValidationTrials).values({ id: "trial", validationId: "validation", jobId: "validation-child", fold: 0, role: "OOS" }).run();
        // 보통 복제는 연관 실험이 아니므로 함께 삭제하면 안 된다.
        database.sqlite.prepare("UPDATE backtest_jobs SET clone_source_job_id='source' WHERE id='independent'").run();
      } else {
        db.insert(intradayValidations).values({ id: "validation", ownerId: owner, sourceJobId: "search-child", requestJson: "{}", configJson: "{}", planJson: "{}", executionVersion: "v1", validationVersion: "v1", strategyVersion: "1", dataRevision: "1", status: "COMPLETED", createdAtMs: 1 }).run();
        db.insert(intradayValidationTrials).values({ id: "trial", validationId: "validation", runId: "validation-child", fold: 0, role: "OOS" }).run();
      }
      const preview = await ctx.app.inject({ method: "POST", url: "/api/v1/backtests/deletion-preview", cookies: { session: cookie }, payload: { mode, ids: ["source", "search-child"] } });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ backtestCount: 3, configurationSearchCount: 1, periodValidationCount: 1, blockers: [] });
      const response = await ctx.app.inject({ method: "POST", url: "/api/v1/backtests/delete", cookies: { session: cookie }, payload: { mode, ids: ["source", "search-child"], token: preview.json().token } });
      expect(response.statusCode, response.body).toBe(204);
      expect(database.sqlite.prepare(`SELECT id FROM ${mode === "daily" ? "backtest_jobs" : "intraday_runs"}`).all()).toEqual([{ id: "independent" }]);
      expect(db.select().from(configurationSearches).all()).toHaveLength(0);
      expect(db.select().from(configurationSearchItems).all()).toHaveLength(0);
      expect(database.sqlite.prepare(`SELECT id FROM ${mode === "daily" ? "backtest_validations" : "intraday_validations"}`).all()).toHaveLength(0);
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  }

  it("삭제 범위 변경·활성 후손·다른 소유자·실패는 어떤 결과도 부분 삭제하지 않는다", async ({ ctx, cookie }) => {
    const database = ctx.container.database, f = fixtures(database);
    f.job("source"); f.job("unrelated");
    const payload = { mode: "daily", ids: ["source", "unrelated"] };
    const request = (path: string, body: Record<string, unknown> = payload) => ctx.app.inject({ method: "POST", url: `/api/v1/backtests/${path}`, cookies: { session: cookie }, payload: body });
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/backtests/deletion-preview", payload })).statusCode).toBe(401);
    const preview = (await request("deletion-preview")).json();
    f.validation("new-validation", "source"); f.trial("new-validation", "new-child", 1);
    const stale = await request("delete", { ...payload, token: preview.token });
    expect(stale.statusCode).toBe(409);
    expect(database.sqlite.prepare("SELECT count(*) AS n FROM backtest_jobs").get()).toEqual({ n: 3 });
    database.sqlite.prepare("UPDATE backtest_jobs SET status='RUNNING' WHERE id='new-child'").run();
    const active = (await request("deletion-preview")).json();
    expect(active.blockers.length).toBeGreaterThan(0);
    expect((await request("delete", { ...payload, token: active.token })).statusCode).toBe(409);
    database.sqlite.prepare("UPDATE backtest_jobs SET status='COMPLETED' WHERE id='new-child'").run();
    database.db.insert(configurationSearches).values({ id: "foreign-search", ownerId: "other-user", requestId: "foreign", mode: "daily", sourceJobId: "source", configJson: "{}", catalogJson: "{}", runtimeIdentity: "v1", status: "PREVIEW", createdAtMs: 1 }).run();
    expect((await request("deletion-preview")).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/v1/backtests/source", cookies: { session: cookie } })).statusCode).toBe(404);
    database.sqlite.prepare("DELETE FROM configuration_searches WHERE id='foreign-search'").run();
    database.sqlite.exec("CREATE TRIGGER refuse_result_delete BEFORE DELETE ON backtest_jobs BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    expect(() => new BacktestDeletionService(database.db).delete("owner", "daily", ["source"])).toThrow(expect.objectContaining({ cause: expect.objectContaining({ message: "test rollback" }) }));
    expect(database.sqlite.prepare("SELECT count(*) AS n FROM backtest_validations").get()).toEqual({ n: 1 });
    expect(database.sqlite.prepare("SELECT count(*) AS n FROM backtest_validation_trials").get()).toEqual({ n: 1 });
    expect(database.sqlite.prepare("SELECT count(*) AS n FROM backtest_jobs").get()).toEqual({ n: 3 });
  });

  it("설정 탐색 자식 직접 삭제는 형제를 포함하고 원본을 보존한다", async ({ ctx, cookie, admin }) => {
    const database = ctx.container.database, f = fixtures(database);
    const ownerId = ctx.container.userRepository.findByUsername(admin.username)!.id;
    f.job("source"); f.job("child1"); f.job("child2");
    database.db.insert(configurationSearches).values({ id: "search", ownerId, requestId: "request", mode: "daily", sourceJobId: "source", configJson: "{}", catalogJson: "{}", runtimeIdentity: "v1", status: "COMPLETED", createdAtMs: 1 }).run();
    database.db.insert(configurationSearchItems).values([
      { id: "item1", searchId: "search", ordinal: 0, requestJson: "{}", valuesJson: "{}", status: "COMPLETED", jobId: "child1" },
      { id: "item2", searchId: "search", ordinal: 1, requestJson: "{}", valuesJson: "{}", status: "COMPLETED", jobId: "child2" },
    ]).run();
    expect(new BacktestDeletionService(database.db).preview(ownerId, "daily", ["child1"]))
      .toMatchObject({ backtestCount: 2, configurationSearchCount: 1, periodValidationCount: 0 });
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/v1/backtests/child1", cookies: { session: cookie } })).statusCode).toBe(204);
    expect(database.sqlite.prepare("SELECT id FROM backtest_jobs").all()).toEqual([{ id: "source" }]);
  });

  // 기존 이력 검사는 정렬만 확인한다. 부분 OOS·기준 전략이 요약을 왜곡하거나 원본 간 섞이는 경계를 검증한다.
  it("완료된 실험의 독립 OOS 평균을 집계하고 표본 수와 기록 수를 구분한다", async ({ ctx, cookie }) => {
    const database = ctx.container.database;
    const f = fixtures(database);
    f.job("source", 25);
    f.job("other");
    f.validation("holdout", "source", "COMPLETED", "OPTIMIZED_HOLDOUT"); f.trial("holdout", "oos1", 10);
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
    expect(source).not.toHaveProperty('seed');
    expect(source.validation).toMatchObject({ experimentCount: 4, completedCount: 3, returns: { count: 2, mean: 20 }, modes: { HOLDOUT: 3, WALK_FORWARD: 1 } });
    expect(source.validation.modes).not.toHaveProperty("OPTIMIZED_HOLDOUT");
    expect(backtestLineage(database, "oos1")!.items.some(item => item.label.startsWith("홀드아웃 · 최적화 켜짐"))).toBe(true);
    expect(source.validation.returns.sampleStdDev).toBeCloseTo(Math.sqrt(200));
    expect(summaries.find((s: { jobId: string }) => s.jobId === "other").validation.returns).toEqual({ count: 1, mean: 700, sampleStdDev: null });
    f.validation("active-validation", "source", "ACTIVE");
    expect(historyExtras(database, ["source"])[0]).toMatchObject({ validation: { activeCount: 1 } });
    expect(database.sqlite.prepare("SELECT count(*) AS n FROM backtest_jobs").get()).toEqual(rowsBefore);
  });

  it("기간검증 자식의 부모 경로와 회차·역할을 복원한다", async ({ ctx, cookie }) => {
    const database = ctx.container.database;
    const f = fixtures(database);
    f.job("original");
    f.validation("validation", "original", "COMPLETED", "WALK_FORWARD");
    f.trial("validation", "candidate", 1, "TRAIN", 1, "COMPLETED", 2);
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/backtests/candidate/lineage", cookies: { session: cookie } });
    expect(response.statusCode).toBe(200);
    const lineage = response.json();
    expect(lineage).toMatchObject({ kind: "validation", complete: true, roleLabel: "2회차 · IS 학습 · 후보 3" });
    expect(lineage.items.map((i: { href: string }) => i.href)).toEqual(["/backtests", "/backtests/original", "/backtests/original/validations", "/backtests/validations/validation", "/backtests/candidate"]);
    expect(backtestLineage(database, "original")).toMatchObject({ kind: "original", roleLabel: "결과", complete: true });
    expect(backtestLineage(database, "missing")).toBeNull();
  });

  // 기존 검사는 일반 복제의 출처까지 상위 결과로 해석했다. 기존 기록과 복제 이후 새 실험의 루트 경계를 검증한다.
  it("일반 복제는 원본의 종류나 삭제 여부와 관계없이 독립 결과이며 새 실험의 루트가 된다", async ({ ctx, cookie }) => {
    const database = ctx.container.database;
    const f = fixtures(database);
    f.job("source");
    f.validation("source-validation", "source"); f.trial("source-validation", "oos-child", 1);
    for (const [id, source] of [["same-clone", "source"], ["configured-clone", "source"], ["copy-of-oos", "oos-child"], ["orphan-clone", "deleted"], ["clone-cycle-a", "clone-cycle-b"], ["clone-cycle-b", "clone-cycle-a"]] as const) {
      f.job(id, null, { cloneSourceJobId: source });
      const response = await ctx.app.inject({ method: "GET", url: `/api/v1/backtests/${id}/lineage`, cookies: { session: cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: "original", roleLabel: "결과", complete: true, items: [
        { label: "백테스트", href: "/backtests" },
        { label: `결과 ${id.slice(-6)}`, href: `/backtests/${id}`, description: id },
      ] });
    }
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
