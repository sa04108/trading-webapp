import { expect, test, type Page } from "@playwright/test";
import { login } from "./login";
import { buildPeriodValidationPlan } from "../../src/shared/schemas/period-validation.js";
import type { BacktestRequest } from "../../src/shared/schemas/backtest-request.js";

const sourceId = "navigation-source";
const seedId = "navigation-seed";
const oosId = "navigation-oos";
const request: BacktestRequest = {
  strategyId: "cross-sectional-momentum", parameters: {},
  universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 10 }], rebalanceInterval: { unit: "MONTH", value: 1 } },
  period: { from: "2020-01-01", to: "2024-01-01" }, capital: { initialCash: 10000000, currency: "KRW" },
  execution: { fillTiming: "NEXT_BAR_OPEN", commissionProfileId: "kr-equity-default", slippageProfileId: "fixed-5bps" }, risk: { maxPositions: 5 }, randomSeed: 42,
};
const metrics = { initialCash: 10000000, finalEquity: 11000000, totalReturnPct: 10, cagrPct: 3, maxDrawdownPct: -5, sharpe: 1, tradeCount: 12, winRate: 50, totalCommission: 100, totalTax: 100, totalSlippage: 100 };
const rootItems = [{ label: "백테스트", href: "/backtests" }, { label: "직접 실행 source", href: `/backtests/${sourceId}` }];
const seedItems = [...rootItems, { label: "난수 시드 실험", href: `/backtests/${sourceId}/seeds` }, { label: "실험 batch", href: "/backtests/batches/navigation-batch" }, { label: "시드 77", href: `/backtests/${seedId}` }];
const oosItems = [...rootItems, { label: "기간검증", href: `/backtests/${sourceId}/validations` }, { label: "홀드아웃 validation", href: "/backtests/validations/navigation-validation" }, { label: "1회차 · OOS 검증", href: `/backtests/${oosId}` }];

async function setup(page: Page) {
  await login(page);
  const state: { count: number | null } = { count: null };
  await page.route(`**/api/v1/backtests/${sourceId}/clone-random-seeds`, (route) => {
    state.count = route.request().postDataJSON().count;
    return route.fulfill({ status: 201, json: { batch: { id: "navigation-batch" } } });
  });
  await page.route("**/api/v1/strategies", (route) => route.fulfill({ json: { strategies: [{ id: request.strategyId, name: "횡단면 모멘텀", version: "1", description: "", supportsRandomSeed: true }] } }));
  await page.route(`**/api/v1/strategies/${request.strategyId}/schema`, (route) => route.fulfill({ json: { schema: { type: "object", properties: {} } } }));
  for (const id of [sourceId, seedId, oosId]) {
    await page.route(`**/api/v1/backtests/${id}`, (route) => route.fulfill({ json: { job: { id, status: "COMPLETED", request, strategyId: request.strategyId, createdAtMs: 1, completedAtMs: 2, cloneBatchId: id === seedId ? "navigation-batch" : null, cloneSourceJobId: id === seedId ? sourceId : null, error: null }, run: null, metrics, benchmark: null, provenancePin: null, universeRebalancing: [] } }));
    await page.route(`**/api/v1/backtests/${id}/series`, (route) => route.fulfill({ json: { equity: [], benchmark: [], drawdown: [], monthly: [], symbols: [], totalEquityPoints: 0 } }));
    await page.route(`**/api/v1/backtests/${id}/trades?**`, (route) => route.fulfill({ json: { trades: [], total: 0 } }));
    await page.route(`**/api/v1/backtests/${id}/lineage`, (route) => route.fulfill({ json: { items: id === seedId ? seedItems : id === oosId ? oosItems : rootItems, kind: id === seedId ? "seed" : id === oosId ? "validation" : "original", roleLabel: id === seedId ? "난수 시드 77" : id === oosId ? "1회차 · OOS 검증" : "직접 실행", complete: true } }));
  }
  await page.route("**/api/v1/backtests/history-extras?**", (route) => route.fulfill({ json: { summaries: new URL(route.request().url()).searchParams.get("jobIds")!.split(",").map((jobId) => ({ jobId, benchmarkExcessReturnPct: 3, seed: { batchCount: 1, activeCount: 0, completedCount: 2, returns: { count: 2, mean: 10, sampleStdDev: 2 } }, validation: { experimentCount: 1, activeCount: 0, completedCount: 1, returns: { count: 1, mean: 10, sampleStdDev: null }, modes: { HOLDOUT: 1, OPTIMIZED_HOLDOUT: 0, WALK_FORWARD: 0 } } })) } }));
  const batch = { id: "navigation-batch", sourceJobId: sourceId, strategyId: request.strategyId, request, status: "COMPLETED", totalCount: 1, completedCount: 1, failedCount: 0, cancelledCount: 0, interruptedCount: 0, deletedCount: 0, pendingCount: 0, queuedCount: 0, runningCount: 0, createdAtMs: 1, completedAtMs: 2, error: null, items: [{ ordinal: 0, randomSeed: 77, jobId: seedId, status: "COMPLETED", metrics }] };
  await page.route("**/api/v1/backtest-clone-batches?**", (route) => route.fulfill({ json: { batches: [batch] } }));
  await page.route("**/api/v1/backtest-clone-batches/navigation-batch", (route) => route.fulfill({ json: { batch } }));
  const config = { mode: "HOLDOUT", splitDate: "2023-01-01" } as const;
  const experiment = { id: "navigation-validation", sourceJobId: sourceId, status: "COMPLETED", config, plan: buildPeriodValidationPlan(request, config), initialCash: request.capital.initialCash, createdAtMs: 1, error: null,
    trials: [{ id: "navigation-trial", fold: 0, role: "OOS", candidate: null, parameters: {}, period: { from: "2023-01-01", to: "2024-01-01" }, jobId: oosId, status: "COMPLETED", progress: 100, metrics, error: null, benchmarkReturnPct: 7 }] };
  await page.route(`**/api/v1/backtests/${sourceId}/validations`, (route) => route.fulfill({ json: { experiments: [experiment] } }));
  await page.route("**/api/v1/backtest-validations/navigation-validation", (route) => route.fulfill({ json: { experiment } }));
  return state;
}

// 기존 검증 폼 검사는 부모 경로와 허브 이동을 확인하지 않으므로 실제 라우터·모바일 축약 경로를 검증한다.
test("원본 요약에서 난수·기간검증으로 이동하고 직접 열린 자식의 경로를 보존한다", async ({ page }, testInfo) => {
  const state = await setup(page);
  await page.goto(`/backtests/${sourceId}`);
  await expect(page.getByRole("navigation", { name: "백테스트 경로" })).toContainText("직접 실행 source");
  await expect(page.getByRole("region", { name: "기간 검증" })).toHaveCount(0);
  const summaries = page.getByRole("region", { name: "백테스트 실험" });
  await expect(summaries).toContainText("기록 1개");
  await summaries.getByRole("link", { name: "난수 시드 실험 열기" }).click();
  await expect(page).toHaveURL(`/backtests/${sourceId}/seeds`);
  await expect(page.getByText("모멘텀 점수가 같은 종목끼리 순서를 정할 때 시드를 사용합니다.")).toBeVisible();
  await expect(page.getByRole("link", { name: "실험 보기", exact: true })).toHaveAttribute("href", "/backtests/batches/navigation-batch");
  await page.getByLabel("복제 개수 (1~100)").fill("0");
  await expect(page.getByRole("button", { name: "난수 실험 시작" })).toBeDisabled();
  await page.getByLabel("복제 개수 (1~100)").fill("3");
  await page.getByRole("button", { name: "난수 실험 시작" }).click();
  await expect.poll(() => state.count).toBe(3);
  await expect(page).toHaveURL("/backtests/batches/navigation-batch");
  await page.locator(`a[href='/backtests/${seedId}']`).click();
  await expect(page.getByRole("navigation", { name: "백테스트 경로" })).toContainText("시드 77");

  await page.goto(`/backtests/${sourceId}`);
  await page.getByRole("link", { name: "기간검증 열기" }).click();
  await page.getByRole("link", { name: "상세 보기", exact: true }).click();
  await expect(page).toHaveURL("/backtests/validations/navigation-validation");
  await page.locator(`a[href='/backtests/${oosId}']`).first().click();
  await expect(page).toHaveURL(`/backtests/${oosId}`);
  await page.reload();
  const crumbs = page.getByRole("navigation", { name: "백테스트 경로" });
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText("1회차 · OOS 검증");
  if (testInfo.project.name === "mobile") await crumbs.getByRole("button", { name: "상위 백테스트 경로 펼치기" }).click();
  await expect(page.getByRole("link", { name: "홀드아웃 validation", exact: true }).filter({ visible: true })).toBeVisible();
  if (testInfo.project.name === "mobile") await page.keyboard.press("Escape");
  for (const width of testInfo.project.name === "mobile" ? [320, 390] : [1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  }
});
