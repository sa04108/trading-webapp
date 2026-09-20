import { expect, vi } from "vitest";
import { authenticatedTest as base } from "../helpers/test-fixtures.js";
import { RestClient } from "../../src/server/shared/rest-client.js";
import { installPreviewShapeStubs } from "../helpers/backtest-preparation-stubs.js";
import { seedSymbolMasterUniverse } from "../helpers/symbol-master-seed.js";
import { waitForPreparationFixture } from "../helpers/test-app.js";

const it = base.extend({ appOptions: { env: { DART_API_KEY: "fixture-key" } } });
const input = {
  universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 1 }], rebalanceInterval: { unit: "DAY", value: 1 } },
  period: { from: "2026-01-05", to: "2026-01-05" }, strategyId: "range-breakout", parameters: {},
};

it("별도 외부 데이터 화면을 위한 조회·승인·수동 수집 API를 제공하지 않는다", async ({ ctx, cookie }) => {
  for (const [method, url] of [
    ["GET", "/provider-data/freshness"], ["GET", "/provider-data/plans"],
    ["GET", "/provider-data/provenance/job"], ["POST", "/provider-data/filings/collect"],
    ["POST", `/provider-data/plans/${"a".repeat(64)}`],
  ] as const) {
    const result = await ctx.app.inject({ method, url: `/api/v1${url}`, cookies: { session: cookie }, ...(method === "POST" ? { payload: { approved: true } } : {}) });
    expect(result.statusCode).toBe(404);
  }
});

it("미리보기는 기존 진행률로 공시 확인을 진행하고 완료 결과를 읽을 때 재수집하지 않는다", async ({ ctx, cookie }) => {
  const restore = installPreviewShapeStubs(ctx);
  const http = vi.spyOn(RestClient.prototype, "request").mockImplementation(async (_group, path, _init, hooks) => {
    expect(path).toMatch(/^\/api\/list\.json\?/);
    hooks?.beforeAttempt?.();
    return { status: "013" };
  });
  try {
    seedSymbolMasterUniverse(ctx.container, ["2026-01-05"], [{ standardCode: "KR7005930003", shortCode: "005930", name: "삼성전자", market: "KOSPI", marketCapKrw: "500000000000000" }]);
    const started = await ctx.app.inject({ method: "POST", url: "/api/v1/backtests/universe-preview", cookies: { session: cookie }, payload: input });
    expect(started.statusCode).toBe(202);
    const id = started.json().job.id as string;
    expect(await waitForPreparationFixture(() => ctx.container.backtestPreparationOrchestrator.get(id), id)).toBe(true);
    expect(http).toHaveBeenCalledTimes(1);
    const completed = await ctx.app.inject({ method: "POST", url: "/api/v1/backtests/universe-preview", cookies: { session: cookie }, payload: { ...input, completedPreparationJobId: id } });
    expect(completed.statusCode).toBe(200);
    expect(http).toHaveBeenCalledTimes(1);
  } finally { await ctx.close(); restore(); vi.restoreAllMocks(); }
});
