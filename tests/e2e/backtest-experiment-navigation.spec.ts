import { expect, test, type Page } from "@playwright/test";
import { login } from "./login";
import { buildPeriodValidationPlan } from "../../src/shared/schemas/period-validation.js";
import type { BacktestRequest } from "../../src/shared/schemas/backtest-request.js";

const sourceId = "navigation-source";
const oosId = "navigation-oos";
const request: BacktestRequest = {
  strategyId: "cross-sectional-momentum", parameters: {},
  universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 10 }], rebalanceInterval: { unit: "MONTH", value: 1 } },
  period: { from: "2020-01-01", to: "2024-01-01" }, capital: { initialCash: 10000000, currency: "KRW" },
  execution: { fillTiming: "NEXT_BAR_OPEN", commissionProfileId: "kr-equity-default", slippageProfileId: "fixed-5bps" }, risk: { maxPositions: 5 }, randomSeed: 42,
};
const metrics = { initialCash: 10000000, finalEquity: 11000000, totalReturnPct: 10, cagrPct: 3, maxDrawdownPct: -5, sharpe: 1, tradeCount: 12, winRate: 50, totalCommission: 100, totalTax: 100, totalSlippage: 100 };
const rootItems = [{ label: "백테스트", href: "/backtests" }, { label: "결과 source", href: `/backtests/${sourceId}` }];
const oosItems = [...rootItems, { label: "기간검증", href: `/backtests/${sourceId}/validations` }, { label: "홀드아웃 · 최적화 꺼짐 validation", href: "/backtests/validations/navigation-validation" }, { label: "1회차 · OOS 검증", href: `/backtests/${oosId}` }];

async function setup(page: Page) {
  await login(page);
  await page.route("**/api/v1/strategies", (route) => route.fulfill({ json: { strategies: [{ id: request.strategyId, name: "횡단면 모멘텀", version: "1", description: "", supportsRandomSeed: true }] } }));
  await page.route(`**/api/v1/strategies/${request.strategyId}/schema`, (route) => route.fulfill({ json: { schema: { type: "object", properties: {} } } }));
  for (const id of [sourceId, oosId]) {
    await page.route(`**/api/v1/backtests/${id}`, (route) => route.fulfill({ json: { job: { id, status: "COMPLETED", request, strategyId: request.strategyId, createdAtMs: 1, completedAtMs: 2, cloneSourceJobId: null, error: null }, run: null, metrics, benchmark: null, provenancePin: null, universeRebalancing: [] } }));
    await page.route(`**/api/v1/backtests/${id}/series`, (route) => route.fulfill({ json: { equity: [], benchmark: [], drawdown: [], monthly: [], symbols: [], totalEquityPoints: 0 } }));
    await page.route(`**/api/v1/backtests/${id}/trades?**`, (route) => route.fulfill({ json: { trades: [], total: 0 } }));
    await page.route(`**/api/v1/backtests/${id}/lineage`, (route) => route.fulfill({ json: { items: id === oosId ? oosItems : rootItems, kind: id === oosId ? "validation" : "original", roleLabel: id === oosId ? "1회차 · OOS 검증" : "결과", complete: true } }));
  }
  await page.route("**/api/v1/backtests/history-extras?**", (route) => route.fulfill({ json: { summaries: new URL(route.request().url()).searchParams.get("jobIds")!.split(",").map((jobId) => ({ jobId, benchmarkExcessReturnPct: 3, validation: { experimentCount: 1, activeCount: 0, completedCount: 1, returns: { count: 1, mean: 10, sampleStdDev: null }, modes: { HOLDOUT: 1, WALK_FORWARD: 0 } } })) } }));
  const config = { mode: "HOLDOUT", splitDate: "2023-01-01" } as const;
  const experiment = { id: "navigation-validation", sourceJobId: sourceId, status: "COMPLETED", config, plan: buildPeriodValidationPlan(request, config), initialCash: request.capital.initialCash, createdAtMs: 1, error: null,
    trials: [{ id: "navigation-trial", fold: 0, role: "OOS", candidate: null, parameters: {}, period: { from: "2023-01-01", to: "2024-01-01" }, jobId: oosId, status: "COMPLETED", progress: 100, metrics, error: null, benchmarkReturnPct: 7 }] };
  await page.route(`**/api/v1/backtests/${sourceId}/validations`, (route) => route.fulfill({ json: { experiments: [experiment] } }));
  await page.route("**/api/v1/backtest-validations/navigation-validation", (route) => route.fulfill({ json: { experiment } }));
}

// 기존 검증 폼 검사는 부모 경로와 허브 이동을 확인하지 않으므로 실제 라우터·모바일 축약 경로를 검증한다.
test("원본 요약에서 기간검증으로 이동하고 직접 열린 자식의 경로를 보존한다", async ({ page }, testInfo) => {
  await setup(page);
  await page.goto(`/backtests/${sourceId}`);
  await expect(page.getByRole("navigation", { name: "백테스트 경로" })).toContainText("결과 source");
  await expect(page.getByRole("region", { name: "기간 검증" })).toHaveCount(0);
  const summaries = page.getByRole("region", { name: "백테스트 실험" });
  await expect(summaries).toContainText("기록 1개");
  await expect(summaries.getByRole("link", { name: "설정 탐색 실험 열기" })).toHaveAttribute("href", `/backtests/${sourceId}/search`);
  await page.getByRole("link", { name: "기간검증 열기" }).click();
  await page.getByRole("link", { name: "상세 보기", exact: true }).click();
  await expect(page).toHaveURL("/backtests/validations/navigation-validation");
  await page.locator(`a[href='/backtests/${oosId}']`).first().click();
  await expect(page).toHaveURL(`/backtests/${oosId}`);
  await page.reload();
  const crumbs = page.getByRole("navigation", { name: "백테스트 경로" });
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText("1회차 · OOS 검증");
  if (testInfo.project.name === "mobile") await crumbs.getByRole("button", { name: "상위 백테스트 경로 펼치기" }).click();
  await expect(page.getByRole("link", { name: "홀드아웃 · 최적화 꺼짐 validation", exact: true }).filter({ visible: true })).toBeVisible();
  if (testInfo.project.name === "mobile") await page.keyboard.press("Escape");
  for (const width of testInfo.project.name === "mobile" ? [320, 390] : [1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  }
});

// 원본 자금과 설정을 새 계좌에 복사하고 취소나 새로고침이 추가 계좌를 만들지 않아야 한다.
test("일봉 결과에서 새 모의투자의 설정을 자동으로 연다", async ({ page }) => {
  await setup(page);
  const artifact = { strategyId: request.strategyId, name: "횡단면 모멘텀", version: "1", artifactHash: "a".repeat(64), executionVersion: "b".repeat(64), latest: true, parameterSchema: { type: "object", properties: {} } };
  const setupValue = { strategyId: request.strategyId, artifactHash: artifact.artifactHash, parameters: {}, universeRule: request.universeRule, timeframe: "1d", budgetKrw: 10_000_000, maxPositions: 5, maxPositionPercent: 100, dailyLossLimitPercent: 3, maxOrderKrw: 1_000_000, maxSlippageBps: 50, randomSeed: 42, sourceJobId: sourceId };
  const deployment = { ...setupValue, id: "paper-daily", name: artifact.name, version: "1", status: "INACTIVE", lastError: null, activity: "대기" };
  const snapshot = { revision: 1, deployment, dataPreparation: null, paperCapital: { initialCashKrw: 10_000_000, canEdit: true }, broker: { provider: "PAPER", configured: true, accounts: [], selectedAccountId: "PAPER", lastSyncAtMs: null, error: null }, account: null, performance: null, positions: [], orders: [], events: [], blockers: [] };
  const requests: unknown[] = [];
  await page.route(`**/api/v1/trading/source/${sourceId}`, (route) => route.fulfill({ json: { setup: setupValue, error: null } }));
  await page.route("**/api/v1/trading/presets", (route) => {
    if (route.request().method() === "POST") { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { id: "paper-daily", snapshot } }); }
    return route.fulfill({ json: { presets: [{ id: "paper-daily", title: artifact.name, status: "INACTIVE" }] } });
  });
  await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [artifact] } }));
  await page.route("**/api/v1/trading?**", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/v1/trading", (route) => route.fulfill({ json: { ...snapshot, deployment: null } }));
  await page.goto(`/backtests/${sourceId}`);
  await page.getByRole("button", { name: "이 설정으로 매매 준비" }).click();
  const dialog = page.getByRole("dialog", { name: "매매 설정" });
  await expect(dialog.getByLabel("초기 모의자금 (원)")).toHaveValue("10000000");
  await expect(dialog.getByLabel("운용 예산 (원)")).toHaveValue("10000000");
  expect(requests).toEqual([{ ...setupValue, initialCashKrw: 10_000_000, expectedRevision: 0, requestId: expect.any(String) }]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "자동 매매 OFF" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "자동 매매 OFF" })).toBeVisible();
  expect(requests).toHaveLength(1);
});
