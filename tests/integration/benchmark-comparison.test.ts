import { and, eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import { authenticatedTest as it } from "../helpers/test-fixtures.js";
import { createTestAdmin } from "../helpers/test-app.js";
import { backtestJobs } from "../../src/runtime/shared/db/operations-schema.js";
import { benchmarkDailyValues } from "../../src/runtime/shared/db/data-schema.js";
import { backtestMetrics } from "../../src/server/shared/db/backtest-result-schema.js";
import { backtestBenchmarkSelections } from "../../src/server/shared/db/backtest-benchmark-schema.js";

const period = { from: "2026-01-05", to: "2026-01-07" };

describe("결과 화면의 벤치마크 비교", () => {
  // 기존 pin 비교 테스트는 선택 저장·현재 데이터 재조회·원본 불변성을 확인하지 못했다.
  it("옛 결과는 미선택으로 열고 ID만 저장해 현재 가격으로 비교하며 원본을 보존한다", async ({ ctx, cookie }) => {
    const db = ctx.container.database.db;
    const legacy = { id: "legacy", strategyId: "range-breakout", status: "COMPLETED", requestJson: JSON.stringify({ period, benchmarkId: "KOSPI" }), universeRuleJson: "{}", universeScheduleJson: "[]", benchmarkJson: "{옛 형식", benchmarkHash: "old-hash", createdAtMs: 1 };
    db.insert(backtestJobs).values(legacy).run();
    db.insert(backtestMetrics).values({ jobId: legacy.id, totalReturnPct: 25, maxDrawdownPct: -5, tradeCount: 1, metricsJson: JSON.stringify({ totalReturnPct: 25 }) }).run();
    for (const [benchmarkId, closes] of [["KOSPI", [100, 80, 110]], ["SP500", [100, 120, 108]]] as const) {
      db.insert(benchmarkDailyValues).values(closes.map((close, i) => ({ benchmarkId, date: `2026-01-0${5 + i}`, close, syncedAtMs: 1 }))).run();
    }
    const get = () => ctx.app.inject({ method: "GET", url: "/api/v1/backtests/legacy/benchmarks", cookies: { session: cookie } });
    const save = (benchmarkIds: string[]) => ctx.app.inject({ method: "PATCH", url: "/api/v1/backtests/legacy/benchmarks", cookies: { session: cookie }, payload: { benchmarkIds } });
    expect((await get()).json()).toMatchObject({ benchmarkIds: [], comparisons: [] });
    expect((await save(["KOSPI", "SP500", "KOSDAQ"])).statusCode).toBe(200);
    const result = (await get()).json();
    expect(result.benchmarkIds).toEqual(["KOSPI", "SP500", "KOSDAQ"]);
    const [kospi, sp500, kosdaq] = result.comparisons;
    expect(kospi.totalReturnPct).toBeCloseTo(10);
    expect(kospi.maxDrawdownPct).toBeCloseTo(-20);
    expect(kospi.excessReturnPct).toBeCloseTo(15);
    expect(kospi.points[0]).toEqual({ tsMs: Date.parse("2026-01-05T00:00:00Z"), value: 0 });
    expect(kospi.points[1].value).toBeCloseTo(-20);
    expect(sp500.totalReturnPct).toBeCloseTo(8);
    expect(sp500.maxDrawdownPct).toBeCloseTo(-10);
    expect(kosdaq).toMatchObject({ available: false, totalReturnPct: null, points: [] });
    expect(db.select().from(backtestBenchmarkSelections).all()).toEqual([{ userId: expect.any(String), jobId: "legacy", benchmarkIdsJson: '["KOSPI","SP500","KOSDAQ"]' }]);
    const exported = (await ctx.app.inject({ method: "GET", url: "/api/v1/backtests/legacy/export", cookies: { session: cookie } })).json();
    expect(exported.benchmarkIds).toEqual(["KOSPI", "SP500", "KOSDAQ"]);
    expect(exported).not.toHaveProperty("benchmark");
    expect(exported.metrics.totalReturnPct).toBe(25);
    db.update(benchmarkDailyValues).set({ close: 115 }).where(and(eq(benchmarkDailyValues.benchmarkId, "KOSPI"), eq(benchmarkDailyValues.date, period.to))).run();
    expect((await get()).json().comparisons[0].totalReturnPct).toBeCloseTo(15);
    expect(db.select().from(backtestJobs).where(eq(backtestJobs.id, "legacy")).get()).toMatchObject(legacy);
    await save([]);
    expect((await get()).json()).toMatchObject({ benchmarkIds: [], comparisons: [] });
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/backtests/legacy", cookies: { session: cookie } })).json().metrics.totalReturnPct).toBe(25);
  });

  // 인증만 확인하던 기존 결과 API 테스트는 새 개인 보기 설정의 교차 사용자 덮어쓰기를 다루지 않는다.
  it("개인별 선택을 분리하고 완료 상태·입력 범위를 검사하며 결과 삭제 시 설정도 정리한다", async ({ ctx, cookie }) => {
    const db = ctx.container.database.db;
    for (const id of ["done", "pending"]) db.insert(backtestJobs).values({ id, strategyId: "test", status: id === "done" ? "COMPLETED" : "FAILED", requestJson: JSON.stringify({ period }), universeRuleJson: "{}", universeScheduleJson: "[]", createdAtMs: 1 }).run();
    const url = "/api/v1/backtests/done/benchmarks";
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "PATCH", url, payload: { benchmarkIds: [] } })).statusCode).toBe(401);
    for (const [id, status] of [["missing", 404], ["pending", 409]] as const) {
      for (const method of ["GET", "PATCH"] as const) expect((await ctx.app.inject({ method, url: `/api/v1/backtests/${id}/benchmarks`, cookies: { session: cookie }, ...(method === "PATCH" ? { payload: { benchmarkIds: [] } } : {}) })).statusCode).toBe(status);
    }
    for (const payload of [{ benchmarkIds: ["bad"] }, { benchmarkIds: ["KOSPI", "KOSPI"] }, { benchmarkIds: [], userId: "someone" }]) expect((await ctx.app.inject({ method: "PATCH", url, cookies: { session: cookie }, payload })).statusCode).toBe(400);
    await ctx.app.inject({ method: "PATCH", url, cookies: { session: cookie }, payload: { benchmarkIds: ["KOSPI"] } });
    const other = await createTestAdmin(ctx.container, { username: "second" });
    const login = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: other.username, password: other.password } });
    const otherCookie = login.cookies.find((item) => item.name === "session")!.value;
    expect((await ctx.app.inject({ method: "GET", url, cookies: { session: otherCookie } })).json().benchmarkIds).toEqual([]);
    await ctx.app.inject({ method: "PATCH", url, cookies: { session: otherCookie }, payload: { benchmarkIds: ["SP500"] } });
    expect((await ctx.app.inject({ method: "GET", url, cookies: { session: cookie } })).json().benchmarkIds).toEqual(["KOSPI"]);
    db.delete(backtestJobs).where(eq(backtestJobs.id, "done")).run();
    expect(db.select().from(backtestBenchmarkSelections).all()).toEqual([]);
  });
});
