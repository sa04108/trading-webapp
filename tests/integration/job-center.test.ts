import { describe, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { authenticatedTest as it } from "../helpers/test-fixtures.js";
import { createTestAdmin } from "../helpers/test-app.js";
import type { Container } from "../../src/server/bootstrap/container.js";
import { backtestJobs, backtestPreparationJobs } from "../../src/runtime/shared/db/operations-schema.js";
import { intradayValidations, intradayValidationTrials } from "../../src/server/shared/db/intraday-validation-schema.js";
import { intradayCollections, intradayRuns } from "../../src/server/shared/db/intraday-schema.js";
import { backtestMetrics } from "../../src/server/shared/db/backtest-result-schema.js";
import { backtestValidations, backtestValidationTrials } from "../../src/server/shared/db/backtest-validation-schema.js";
import { backgroundJobHistory, jobDismissals } from "../../src/server/shared/db/job-center-schema.js";
import { pruneExpiredRows } from "../../src/server/shared/db/maintenance.js";
import type { JobItem, JobResponse, JobsResponse } from "../../src/shared/schemas/jobs.js";
import { BackgroundJobHistory } from "../../src/server/modules/jobs/application/background-job-history.js";

const day = 86_400_000;
const request = { strategyId: "range-breakout", symbol: "005930", period: { from: "2026-01-05", to: "2026-02-05" } };
function backtest(container: Container, id: string, status: string, createdAtMs = Date.now(), extra: Partial<typeof backtestJobs.$inferInsert> = {}) {
  container.database.db.insert(backtestJobs).values({ id, status, createdAtMs, strategyId: request.strategyId, requestJson: JSON.stringify(request), universeRuleJson: "{}", universeScheduleJson: "[]", ...extra }).run();
}
function preparation(container: Container, id: string, status: string, updatedAtMs = Date.now()) {
  container.database.db.insert(backtestPreparationJobs).values({ id, status, phase: "RESOLVING_STAGES", requestHash: id, requestJson: JSON.stringify(request), createdAtMs: updatedAtMs - 1000, updatedAtMs,
    completedAtMs: ["COMPLETED", "FAILED", "CANCELLED"].includes(status) ? updatedAtMs : null }).run();
}

describe("작업 관찰·취소·이력 경계", () => {
  // 개별 전환 API만으로는 작업 센터의 소유권, 실패 사유와 이력 삭제 계약을 검증할 수 없다.
  it("자동 매매 전환 작업을 소유자별로 관찰하고 종료 이력만 숨긴다", async ({ ctx, cookie, admin }) => {
    const now = Date.now();
    const owner = ctx.container.userRepository.findByUsername(admin.username)!.id;
    const insert = ctx.container.database.sqlite.prepare(`INSERT INTO trading_toggle_jobs
      (id, deployment_id, owner_id, action, title, status, message, created_at_ms, updated_at_ms, finished_at_ms, executor_token, expected_revision, account_slot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    insert.run("active", "account / 1", owner, "activate", "모의 계좌", "RUNNING", "연결 중", now, now, null, "token", 1);
    insert.run("failed", "account / 1", owner, "deactivate", "모의 계좌", "FAILED", "연결 실패", now, now, now, "token", 1);
    insert.run("foreign", "foreign", "other-owner", "activate", "다른 계좌", "FAILED", "비공개 오류", now, now, now, "token", 1);
    const get = (path: string) => ctx.app.inject({ method: "GET", url: `/api/v1/jobs${path}`, cookies: { session: cookie } });
    const list = (await get("?status=all")).json<JobsResponse>();
    expect(list).toMatchObject({ total: 2, activeCount: 1, finishedCount: 1, selectionCount: 1 });
    expect(list.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "trading-toggle:active", kind: "trading-toggle", title: "모의 계좌 · 자동 매매 켜기", phase: "연결 중", cancellable: false, link: "/trading?presetId=account%20%2F%201" }),
      expect.objectContaining({ id: "trading-toggle:failed", title: "모의 계좌 · 자동 매매 끄기", status: "FAILED", error: "연결 실패", cancellable: false }),
    ]));
    expect((await get("/trading-toggle:foreign")).statusCode).toBe(404);
    expect((await get("?status=error")).json<JobsResponse>().jobs.map((job) => job.id)).toEqual(["trading-toggle:failed"]);
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/jobs/trading-toggle:active/cancel", cookies: { session: cookie } })).statusCode).toBe(409);
    const remove = (ids: string[]) => ctx.app.inject({ method: "DELETE", url: "/api/v1/jobs", cookies: { session: cookie }, payload: { ids } });
    expect((await remove(["trading-toggle:active"])).statusCode).toBe(409);
    expect((await remove(["trading-toggle:foreign"])).statusCode).toBe(404);
    expect((await remove(["trading-toggle:failed"])).statusCode).toBe(204);
    expect((await get("/trading-toggle:failed")).statusCode).toBe(404);
    expect((await get("?status=all")).json<JobsResponse>()).toMatchObject({ total: 1, activeCount: 1, finishedCount: 0 });
    expect(ctx.container.database.sqlite.prepare("SELECT status, message FROM trading_toggle_jobs WHERE id=?").get("failed")).toEqual({ status: "FAILED", message: "연결 실패" });
  });

  it("분봉 검증의 완료와 미평가 수를 작업 센터에 표시한다", async ({ ctx, cookie, admin }) => {
    const now = Date.now(), ownerId = ctx.container.userRepository.findByUsername(admin.username)!.id;
    const db = ctx.container.database.db;
    db.insert(intradayRuns).values([
      { id: "intraday-validation-source", ownerId, status: "COMPLETED", requestJson: JSON.stringify(request), createdAtMs: now, updatedAtMs: now },
      { id: "intraday-validation-child", ownerId, status: "COMPLETED", requestJson: JSON.stringify(request), resultJson: "large result must not be read", createdAtMs: now, updatedAtMs: now },
    ]).run();
    db.insert(intradayValidations).values({ id: "intraday-validation-progress", ownerId, sourceJobId: "intraday-validation-source", requestJson: JSON.stringify(request), configJson: "{}", planJson: JSON.stringify({ totalRuns: 3 }), executionVersion: "1", validationVersion: "1", strategyVersion: "1", dataRevision: "1", status: "COMPLETED", createdAtMs: now, completedAtMs: now }).run();
    db.insert(intradayValidationTrials).values([
      { id: "intraday-progress-train", validationId: "intraday-validation-progress", fold: 0, role: "TRAIN", runId: "intraday-validation-child" },
      { id: "intraday-progress-skip", validationId: "intraday-validation-progress", fold: 0, role: "OOS", skipReason: "NO_ELIGIBLE_CANDIDATE" },
      { id: "intraday-progress-pending", validationId: "intraday-validation-progress", fold: 0, role: "BASELINE" },
    ]).run();
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/jobs/intraday-validation:intraday-validation-progress", cookies: { session: cookie } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<JobResponse>().job).toMatchObject({ description: "005930 · 2026-01-05 ~ 2026-02-05", progress: { current: 2, total: 3 } });
  });

  // 서비스의 미평가 DTO 검사만으로는 작업 센터의 JOIN이 이 행을 누락하는 문제를 찾지 못한다.
  it("선택 OOS가 미평가여도 종료된 기간검증의 진행률과 사유를 표시한다", async ({ ctx, cookie }) => {
    const now = Date.now();
    for (const id of ["validation-source", "validation-train", "validation-baseline"])
      backtest(ctx.container, id, "COMPLETED", now, { completedAtMs: now });
    ctx.container.database.db.insert(backtestValidations).values({
      id: "validation-no-candidate", sourceJobId: "validation-source", requestJson: JSON.stringify(request),
      configJson: '{}', planJson: JSON.stringify({ totalRuns: 3 }), strategyVersion: '1', strategySourceHash: 'test',
      engineVersion: '1', gitCommitSha: 'test', status: 'COMPLETED', phase: 'OOS', createdAtMs: now, completedAtMs: now,
    }).run();
    ctx.container.database.db.insert(backtestValidationTrials).values([
      { id: "trial-is", validationId: "validation-no-candidate", fold: 0, role: "TRAIN", jobId: "validation-train" },
      { id: "trial-oos", validationId: "validation-no-candidate", fold: 0, role: "OOS", skipReason: "NO_ELIGIBLE_CANDIDATE" },
      { id: "trial-baseline", validationId: "validation-no-candidate", fold: 0, role: "BASELINE", jobId: "validation-baseline" },
    ]).run();
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/jobs/validation:validation-no-candidate", cookies: { session: cookie } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<JobResponse>().job).toMatchObject({ status: "COMPLETED", progress: { current: 3, total: 3, percent: 100 }, description: expect.stringContaining("OOS 1회 미평가") });
  });

  // 기존 개별 작업 API 검사는 통합 목록의 소유권·종료 이력 삭제와 원본 보존을 검증하지 않는다.
  it("모든 작업 API는 인증과 제한된 조회·삭제 입력을 요구한다", async ({ ctx, cookie }) => {
    for (const [method, url] of [["GET", "/jobs"], ["GET", "/jobs/backtest:nope"], ["POST", "/jobs/backtest:nope/cancel"], ["DELETE", "/jobs"]] as const) {
      expect((await ctx.app.inject({ method, url: `/api/v1${url}`, ...(method === "DELETE" ? { payload: { ids: ["a"] } } : {}) })).statusCode).toBe(401);
    }
    for (const query of ["limit=0", "limit=101", "offset=-1", "status=invalid"]) {
      expect((await ctx.app.inject({ method: "GET", url: `/api/v1/jobs?${query}`, cookies: { session: cookie } })).statusCode).toBe(400);
    }
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/v1/jobs", cookies: { session: cookie }, payload: { ids: [] } })).statusCode).toBe(400);
  });

  it("활성 작업은 보관 기간과 무관하게 보여주며 최근 종료 이력을 페이지화하고 소유자별 분봉·내부 수집을 구분한다", async ({ ctx, cookie, admin }) => {
    const now = Date.now();
    backtest(ctx.container, "old-active", "RUNNING", now - 30 * day, { progressBars: 25, totalBars: 100, executionActivity: "CALCULATING_BACKTEST" });
    backtest(ctx.container, "expired", "COMPLETED", now - 20 * day, { completedAtMs: now - 8 * day });
    backtest(ctx.container, "recent-finish", "COMPLETED", now - 20 * day, { completedAtMs: now });
    for (let i = 0; i < 3; i++) backtest(ctx.container, `finished-${i}`, "FAILED", now - i, { completedAtMs: now - i });
    backtest(ctx.container, "interrupted", "INTERRUPTED", now - 10, { completedAtMs: now - 10 });
    backtest(ctx.container, "user-cancelled", "CANCELLED", now - 11, { completedAtMs: now - 11 });
    for (const [id, ownerId, status] of [["own", ctx.container.userRepository.findByUsername(admin.username)!.id, "PREPARING"], ["foreign", "another-owner", "RUNNING"], ["foreign-failed", "another-owner", "FAILED"]]) {
      ctx.container.database.db.insert(intradayRuns).values({ id: id!, ownerId: ownerId!, status: status!, requestJson: JSON.stringify(request), resultJson: "not parsed for observation", createdAtMs: now, updatedAtMs: now }).run();
    }
    for (const [id, parentRunId] of [["manual", null], ["internal", "own"]]) {
      ctx.container.database.db.insert(intradayCollections).values({ id: id!, ownerId: ctx.container.userRepository.findByUsername(admin.username)!.id, parentRunId, symbol: "005930", periodJson: JSON.stringify(request.period), status: "RUNNING", fetchedBars: 120, pages: 3, createdAtMs: now, updatedAtMs: now }).run();
    }
    const get = (path: string) => ctx.app.inject({ method: "GET", url: `/api/v1/jobs${path}`, cookies: { session: cookie } });
    const first = await get("?limit=2");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    const page = first.json<JobsResponse>();
    expect(page.total).toBe(9);
    expect(page.activeCount).toBe(3);
    expect(page.jobs).toHaveLength(2);
    expect(page.jobs.every((job) => job.finishedAtMs === null)).toBe(true);
    const all = (await get("")).json<JobsResponse>().jobs;
    for (const hidden of ["backtest:expired", "intraday-backtest:foreign", "intraday-collection:internal"]) expect(all.map((job) => job.id)).not.toContain(hidden);
    expect(all.find((job) => job.id === "backtest:old-active")?.progress?.percent).toBe(25);
    expect(all.find((job) => job.id === "intraday-backtest:own")?.progress).toMatchObject({ current: 120, total: null, percent: null });
    expect((await get("?status=finished")).json<JobsResponse>()).toMatchObject({ total: 6, activeCount: 3 });
    expect((await get("?limit=2&offset=100")).json<JobsResponse>()).toMatchObject({ offset: 8, total: 9 });
    const errors = (await get("?status=error&limit=2&offset=2")).json<JobsResponse>();
    expect(errors).toMatchObject({ total: 4, activeCount: 3, limit: 2, offset: 2 });
    expect(errors.jobs.map((job) => job.id)).toEqual(["backtest:finished-2", "backtest:interrupted"]);
    const allErrors = (await get("?status=error")).json<JobsResponse>();
    expect(allErrors.jobs.map((job) => job.status)).toEqual(["FAILED", "FAILED", "FAILED", "INTERRUPTED"]);
    for (const path of ["/intraday-backtest:foreign", "/intraday-collection:internal"]) expect((await get(path)).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/jobs/intraday-backtest:foreign/cancel", cookies: { session: cookie } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/v1/jobs", cookies: { session: cookie }, payload: { ids: ["intraday-backtest:foreign"] } })).statusCode).toBe(404);
  });

  it("필터의 모든 종료 이력을 페이지 경계 밖까지 제외 항목과 활성 작업을 보존하며 삭제한다", async ({ ctx, cookie, admin }) => {
    const now = Date.now();
    for (let i = 0; i < 105; i++) backtest(ctx.container, `bulk-${i}`, "FAILED", now, { completedAtMs: now });
    backtest(ctx.container, "bulk-completed", "COMPLETED", now, { completedAtMs: now });
    backtest(ctx.container, "bulk-active", "RUNNING", now);
    ctx.container.database.db.insert(intradayRuns).values({ id: "foreign-bulk", ownerId: "another-owner", status: "FAILED", requestJson: JSON.stringify(request), createdAtMs: now, updatedAtMs: now }).run();
    const get = (query: string) => ctx.app.inject({ method: "GET", url: `/api/v1/jobs${query}`, cookies: { session: cookie } });
    const remove = (payload: object) => ctx.app.inject({ method: "DELETE", url: "/api/v1/jobs", cookies: { session: cookie }, payload });
    expect((await get("?status=error&limit=2")).json()).toMatchObject({ total: 105, finishedCount: 105, activeCount: 1 });
    for (const payload of [{ all: true, status: "errror" }, { all: "true" }, { all: true, excludeIds: [42] }]) expect((await remove(payload)).statusCode).toBe(400);
    expect((await remove({ all: true, status: "active" })).statusCode).toBe(204);
    expect(ctx.container.database.db.select().from(jobDismissals).all()).toEqual([]);
    expect((await remove({ all: true, status: "error", excludeIds: ["backtest:bulk-0"] })).statusCode).toBe(204);
    expect((await get("?status=all")).json()).toMatchObject({ total: 3, finishedCount: 2, activeCount: 1 });
    expect(ctx.container.database.db.select().from(backtestJobs).all()).toHaveLength(107);
    const owner = ctx.container.userRepository.findByUsername(admin.username)!.id;
    expect(ctx.container.database.db.select().from(jobDismissals).all().map(({ userId, jobId }) => ({ userId, jobId })))
      .toEqual(expect.arrayContaining(Array.from({ length: 104 }, (_, i) => ({ userId: owner, jobId: `backtest:bulk-${i + 1}` }))));
    expect(ctx.container.database.db.select().from(jobDismissals).all()).toHaveLength(104);
    expect((await remove({ all: true, status: "error", excludeIds: ["backtest:bulk-0"] })).statusCode).toBe(204);
    expect((await remove({ ids: ["backtest:bulk-0"] })).statusCode).toBe(204);
    expect((await remove({ all: true })).statusCode).toBe(204);
    expect((await get("?status=all")).json()).toMatchObject({ total: 1, finishedCount: 0, activeCount: 1 });
  });

  it("목록 선택 수는 현재 보이는 종료 작업의 유효한 제외 항목만 반영한다", async ({ ctx, cookie }) => {
    const now = Date.now();
    backtest(ctx.container, "selection-a", "FAILED", now, { completedAtMs: now });
    backtest(ctx.container, "selection-b", "FAILED", now, { completedAtMs: now });
    backtest(ctx.container, "selection-active", "RUNNING", now);
    ctx.container.database.db.insert(intradayRuns).values({ id: "selection-foreign", ownerId: "another-owner", status: "FAILED", requestJson: JSON.stringify(request), createdAtMs: now, updatedAtMs: now }).run();
    const list = (payload: object, authenticated = true) => ctx.app.inject({ method: "POST", url: "/api/v1/jobs/list", ...(authenticated ? { cookies: { session: cookie } } : {}), payload });
    const payload = { status: "all", limit: 1, excludeIds: ["backtest:selection-a", "backtest:selection-a", "backtest:missing", "backtest:selection-active", "intraday-backtest:selection-foreign"] };
    expect((await list(payload, false)).statusCode).toBe(401);
    expect((await list({ ...payload, unexpected: true })).statusCode).toBe(400);
    expect((await list(payload)).json()).toMatchObject({ total: 3, activeCount: 1, finishedCount: 2, selectionCount: 1 });
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/jobs?status=all", cookies: { session: cookie } })).json()).toMatchObject({ finishedCount: 2, selectionCount: 2 });
    ctx.container.database.db.delete(backtestJobs).where(eq(backtestJobs.id, "selection-a")).run();
    expect((await list(payload)).json()).toMatchObject({ total: 2, finishedCount: 1, selectionCount: 1 });
    expect((await list({ status: "active", excludeIds: [] })).json()).toMatchObject({ total: 1, finishedCount: 0, selectionCount: 0 });
  });

  it("종료 이력 삭제는 원자적·사용자별이며 원본 백테스트와 지표를 보존한다", async ({ ctx, cookie }) => {
    backtest(ctx.container, "completed", "COMPLETED", Date.now(), { completedAtMs: Date.now() });
    backtest(ctx.container, "running", "RUNNING");
    ctx.container.database.db.insert(backtestMetrics).values({ jobId: "completed", totalReturnPct: 12, maxDrawdownPct: -3, tradeCount: 1, metricsJson: '{"totalReturnPct":12}' }).run();
    const remove = (ids: string[]) => ctx.app.inject({ method: "DELETE", url: "/api/v1/jobs", cookies: { session: cookie }, payload: { ids } });
    expect((await remove(["backtest:completed", "backtest:running"])).statusCode).toBe(409);
    expect(ctx.container.database.db.select().from(jobDismissals).all()).toHaveLength(0);
    expect((await remove(["backtest:completed"])).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/jobs/backtest:completed", cookies: { session: cookie } })).statusCode).toBe(404);
    expect(ctx.container.database.db.select().from(backtestJobs).where(eq(backtestJobs.id, "completed")).get()).toBeDefined();
    expect(ctx.container.database.db.select().from(backtestMetrics).where(eq(backtestMetrics.jobId, "completed")).get()?.totalReturnPct).toBe(12);
    const other = await createTestAdmin(ctx.container, { username: "other-jobs-admin" });
    const login = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: other.username, password: other.password } });
    const secondCookie = login.cookies.find((value) => value.name === "session")!.value;
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/jobs/backtest:completed", cookies: { session: secondCookie } })).statusCode).toBe(200);
  });

  it("취소 전이를 보존하고 공유 준비와 아직 종료되지 않은 취소 작업의 삭제를 막는다", async ({ ctx, cookie }) => {
    backtest(ctx.container, "queued", "QUEUED");
    backtest(ctx.container, "running", "RUNNING");
    preparation(ctx.container, "shared", "QUEUED");
    backtest(ctx.container, "dependent", "QUEUED", Date.now(), { preparationJobId: "shared" });
    const cancel = (id: string) => ctx.app.inject({ method: "POST", url: `/api/v1/jobs/${id}/cancel`, cookies: { session: cookie } });
    const queued = await cancel("backtest:queued");
    expect(queued.statusCode, queued.body).toBe(200);
    expect(queued.json<JobResponse>().job.status).toBe("CANCELLED");
    const running = await cancel("backtest:running");
    expect(running.statusCode, running.body).toBe(200);
    expect(running.json<JobResponse>().job).toMatchObject({ status: "CANCELLING", cancellable: false });
    expect((await cancel("backtest:running")).statusCode).toBe(200);
    expect((await cancel("preparation:shared")).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/v1/jobs", cookies: { session: cookie }, payload: { ids: ["backtest:running"] } })).statusCode).toBe(409);
  });

  it("준비 원본 정리 후에도 종료 이력을 보관하고 만료 정리는 원본 결과와 활성 작업을 보존한다", async ({ ctx, cookie, admin }) => {
    const now = Date.now();
    preparation(ctx.container, "archived", "COMPLETED", now);
    preparation(ctx.container, "old-archive", "FAILED", now - 8 * day);
    ctx.container.database.db.delete(backtestPreparationJobs).where(eq(backtestPreparationJobs.id, "archived")).run();
    ctx.container.database.db.delete(backtestPreparationJobs).where(eq(backtestPreparationJobs.id, "old-archive")).run();
    const archived = await ctx.app.inject({ method: "GET", url: "/api/v1/jobs/preparation:archived", cookies: { session: cookie } });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json<JobResponse>().job).toMatchObject({ id: "preparation:archived", status: "COMPLETED", cancellable: false });
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/jobs/preparation:old-archive", cookies: { session: cookie } })).statusCode).toBe(404);
    backtest(ctx.container, "source-preserved", "COMPLETED", now - 20 * day, { completedAtMs: now - 8 * day });
    ctx.container.database.db.insert(jobDismissals).values({ userId: ctx.container.userRepository.findByUsername(admin.username)!.id, jobId: "backtest:source-preserved", finishedAtMs: now - 8 * day }).run();
    ctx.container.database.db.insert(backgroundJobHistory).values({ id: "benchmark:active", status: "RUNNING", createdAtMs: now - 20 * day, updatedAtMs: now - 20 * day, snapshotJson: "{}" }).run();
    pruneExpiredRows(ctx.container.database.db, now, { idleTimeoutMs: 100 * day, absoluteTimeoutMs: 100 * day, auditLogRetentionMs: 0, notificationRetentionMs: 7 * day });
    expect(ctx.container.database.db.select().from(backgroundJobHistory).all().map((row) => row.id)).toEqual(expect.arrayContaining(["preparation:archived", "benchmark:active"]));
    expect(ctx.container.database.db.select().from(backgroundJobHistory).where(eq(backgroundJobHistory.id, "preparation:old-archive")).get()).toBeUndefined();
    expect(ctx.container.database.db.select().from(jobDismissals).all()).toHaveLength(0);
    expect(ctx.container.database.db.select().from(backtestJobs).where(eq(backtestJobs.id, "source-preserved")).get()).toBeDefined();
  });

  it("수집 취소는 진행 중 요청이 끝날 때까지 관찰하고 종료 이력은 다음 실행과 분리한다", async ({ ctx, cookie }) => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const sync = vi.spyOn(ctx.container.benchmarkService, "syncDate").mockImplementation(async () => { entered(); await pending; });
    try {
      ctx.container.benchmarkService.startBackfill("KOSPI", "2026-01-05", "2026-01-05");
      await started;
      const job = ctx.container.benchmarkService.currentJob()!;
      const cancel = await ctx.app.inject({ method: "POST", url: `/api/v1/jobs/${job.id}/cancel`, cookies: { session: cookie } });
      expect(cancel.statusCode, cancel.body).toBe(200);
      expect(cancel.json<JobResponse>().job.status).toBe("CANCELLING");
      expect((await ctx.app.inject({ method: "DELETE", url: "/api/v1/jobs", cookies: { session: cookie }, payload: { ids: [job.id] } })).statusCode).toBe(409);
      const finished = new Promise<void>((resolve) => {
        const listener = (item: JobItem) => { if (item.id === job.id && item.status === "CANCELLED") { ctx.container.benchmarkService.jobEvents.off("job", listener); resolve(); } };
        ctx.container.benchmarkService.jobEvents.on("job", listener);
      });
      release();
      await finished;
      expect((await ctx.app.inject({ method: "GET", url: `/api/v1/jobs/${job.id}`, cookies: { session: cookie } })).json<JobResponse>().job).toMatchObject({ status: "CANCELLED", cancellable: false });
      expect((await ctx.app.inject({ method: "DELETE", url: "/api/v1/jobs", cookies: { session: cookie }, payload: { ids: [job.id] } })).statusCode).toBe(204);
    } finally { release?.(); sync.mockRestore(); }
  });

  it("재시작 시 고아 수집을 중단 이력으로 복구하고 정상 종료는 사용자 취소와 구분한다", async ({ ctx }) => {
    const now = Date.now();
    const abandoned: JobItem = { id: "benchmark:abandoned", kind: "benchmark", title: "수집", status: "RUNNING", phase: null, description: null,
      progress: null, error: null, createdAtMs: now - 10 * day, updatedAtMs: now - day, finishedAtMs: null, cancellable: true, link: "/datasets/benchmarks" };
    ctx.container.database.db.insert(backgroundJobHistory).values({ id: abandoned.id, status: abandoned.status, createdAtMs: abandoned.createdAtMs, updatedAtMs: abandoned.updatedAtMs, snapshotJson: JSON.stringify(abandoned) }).run();
    const cancelled: JobItem = { ...abandoned, id: "symbol-master:cancelled", kind: "symbol-master", status: "CANCELLING" };
    ctx.container.database.db.insert(backgroundJobHistory).values({ id: cancelled.id, status: cancelled.status, createdAtMs: cancelled.createdAtMs, updatedAtMs: cancelled.updatedAtMs, snapshotJson: JSON.stringify(cancelled) }).run();
    let live: JobItem = { ...abandoned, id: "benchmark:live", createdAtMs: now, updatedAtMs: now };
    const events = new EventEmitter();
    const notify = vi.fn();
    const history = new BackgroundJobHistory(ctx.container.database, ctx.container.clock, ctx.container.logger, [{
      jobEvents: events, currentJob: () => live, cancelJob: (id) => {
        if (id !== live.id) return false;
        live = { ...live, status: "CANCELLED", finishedAtMs: now, cancellable: false };
        events.emit("job", live);
        return true;
      },
    }], notify);
    const saved = (id: string) => JSON.parse(ctx.container.database.db.select().from(backgroundJobHistory).where(eq(backgroundJobHistory.id, id)).get()!.snapshotJson) as JobItem;
    expect(saved(abandoned.id)).toMatchObject({ status: "INTERRUPTED", cancellable: false });
    expect(saved(abandoned.id).finishedAtMs).toBeGreaterThanOrEqual(now);
    expect(saved(cancelled.id)).toMatchObject({ status: "CANCELLED", cancellable: false });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: abandoned.id, status: "INTERRUPTED", link: "/datasets/benchmarks" }));
    expect(saved(live.id).status).toBe("RUNNING");
    await history.close();
    expect(saved(live.id)).toMatchObject({ status: "INTERRUPTED", phase: "서버 종료로 중단됨", cancellable: false });
    expect(notify).toHaveBeenCalledTimes(2);
    const reopened = new BackgroundJobHistory(ctx.container.database, ctx.container.clock, ctx.container.logger, [], notify);
    await reopened.close();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(events.listenerCount("job")).toBe(0);
  });
});
