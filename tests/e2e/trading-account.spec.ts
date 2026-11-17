import { expect, test } from "@playwright/test";
import { login } from "./login";
import type { TradingArtifact, TradingSnapshot } from "../../src/shared/schemas/trading";

const snapshot: TradingSnapshot = {
  revision: 17,
  deployment: null,
  broker: {
    provider: "PAPER",
    configured: true,
    accounts: [],
    selectedAccountId: "PAPER",
    lastSyncAtMs: null,
    error: null,
  },
  account: null,
  performance: null,
  positions: [],
  orders: [],
  events: [],
  blockers: [],
};

// 모달을 연 뒤 주기적인 상태 조회가 작성 중인 설정을 덮지 않아야 한다.
test("전략이 외부에서 교체되어도 초안을 유지하고 명시적 새로 불러오기 뒤 저장한다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  const artifact: TradingArtifact = { strategyId: "range-breakout", name: "전략", description: "검증용",
    version: "1", artifactHash: "a".repeat(64), executionVersion: "b".repeat(64), latest: true,
    parameterSchema: { type: "object", properties: {} } };
  let current: TradingSnapshot = { ...snapshot, deployment: {
    id: "deployment-a", strategyId: artifact.strategyId, name: artifact.name, version: artifact.version,
    artifactHash: artifact.artifactHash, status: "INACTIVE", parameters: {},
    universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 100 }], rebalanceInterval: { unit: "MONTH", value: 1 } },
    timeframe: "1d", budgetKrw: 10_000_000, maxPositions: 10, maxPositionPercent: 10,
    dailyLossLimitPercent: 3, maxOrderKrw: 1_000_000, maxSlippageBps: 50, randomSeed: 42,
    sourceJobId: null, createdAtMs: 1, updatedAtMs: 1, activatedAtMs: null, lastDecisionAtMs: null,
    lastError: null, activity: "대기", latestArtifactHash: artifact.artifactHash, latestVersion: artifact.version,
  } };
  let reads = 0;
  await page.route("**/api/v1/trading", (route) => { reads++; return route.fulfill({ json: current }); });
  await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [artifact] } }));
  let saved: unknown;
  await page.route("**/api/v1/trading/strategy", (route) => {
    saved = { method: route.request().method(), body: route.request().postDataJSON() };
    return route.fulfill({ json: current });
  });
  await page.goto("/trading");
  await page.getByRole("button", { name: "매매 설정" }).click();
  const budget = page.getByLabel("운용 예산 (원)", { exact: true });
  await expect(budget).toHaveValue("10000000");
  await budget.fill("27000000");
  const before = reads;
  await page.clock.runFor(5_100);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(budget).toHaveValue("27000000");
  current = { ...current, revision: 18, deployment: { ...current.deployment!, id: "deployment-b", budgetKrw: 30_000_000 } };
  await page.clock.runFor(5_100);
  await expect(page.getByRole("alert")).toContainText("작성 중인 입력은 유지했습니다");
  await expect(budget).toHaveValue("27000000");
  await expect(page.getByRole("button", { name: "설정 저장", exact: true })).toBeDisabled();
  expect(saved).toBeUndefined();
  await page.getByRole("button", { name: "최신 설정 불러오기", exact: true }).click();
  await expect(budget).toHaveValue("30000000");
  await budget.fill("31000000");
  await page.getByRole("button", { name: "설정 저장", exact: true }).click();
  await expect.poll(() => saved).toMatchObject({ method: "PUT", body: { budgetKrw: 31_000_000, expectedRevision: 18 } });
});

test("자동 매매는 양방향 확인 후 전환하고 ON에서는 설정을 잠근다", async ({ page }) => {
  await login(page);
  const artifact: TradingArtifact = { strategyId: "range-breakout", name: "전략", description: "검증용", version: "1", artifactHash: "a".repeat(64), executionVersion: "b".repeat(64), latest: true, parameterSchema: { type: "object", properties: {} } };
  let current: TradingSnapshot = { ...snapshot, deployment: {
    id: "deployment-a", strategyId: artifact.strategyId, name: artifact.name, version: artifact.version, artifactHash: artifact.artifactHash, status: "INACTIVE", parameters: {}, universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 100 }], rebalanceInterval: { unit: "MONTH", value: 1 } }, timeframe: "1d", budgetKrw: 10_000_000, maxPositions: 10, maxPositionPercent: 10, dailyLossLimitPercent: 3, maxOrderKrw: 1_000_000, maxSlippageBps: 50, randomSeed: 42, sourceJobId: null, createdAtMs: 1, updatedAtMs: 1, activatedAtMs: null, lastDecisionAtMs: null, lastError: null, activity: "대기", latestArtifactHash: artifact.artifactHash, latestVersion: artifact.version,
  } };
  await page.route("**/api/v1/trading", (route) => route.fulfill({ json: current }));
  await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [artifact] } }));
  let writes = 0;
  await page.route("**/api/v1/trading/activate", (route) => { writes++; current = { ...current, revision: 18, deployment: { ...current.deployment!, status: "ACTIVE" } }; return route.fulfill({ json: current }); });
  await page.route("**/api/v1/trading/deactivate", (route) => { writes++; current = { ...current, revision: 19, deployment: { ...current.deployment!, status: "INACTIVE" } }; return route.fulfill({ json: current }); });
  await page.goto("/trading");
  await expect(page.getByText("계좌 연결")).toHaveCount(0);
  await page.getByRole("button", { name: "자동 매매 OFF" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("모의 자동 매매");
  const onColor = await page.getByRole("alertdialog").evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "켜기", exact: true }).click();
  await expect(page.getByRole("button", { name: "자동 매매 ON" })).toBeVisible();
  await page.getByRole("button", { name: "매매 설정" }).click();
  await expect(page.getByLabel("운용 예산 (원)", { exact: true })).toBeDisabled();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "자동 매매 ON" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("자동으로 매도하지 않습니다");
  const offColor = await page.getByRole("alertdialog").evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(offColor).not.toBe(onColor);
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "끄기", exact: true }).click();
  await expect(page.getByRole("button", { name: "자동 매매 OFF" })).toBeVisible();
});

test("보유 종목에서 시세와 제공 시각을 확인한다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  const current = { ...snapshot, positions: [{ symbol: "005930", name: "삼성전자", quantity: 1, availableQuantity: 1, averagePrice: 70000, price: 71000, marketValue: 71000, unrealizedPnl: 1000, returnPercent: 1.43, deploymentId: null }] };
  await page.route("**/api/v1/trading", (route) => route.fulfill({ json: current }));
  await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [] } }));
  let quotes = 0;
  await page.route("**/api/v1/trading/quotes/005930", (route) => { quotes++; return route.fulfill({ json: { symbol: "005930", price: 72000, timestampMs: 1700000000000 } }); });
  await page.route("**/api/v1/intraday/chart?*", (route) => route.fulfill({ json: { symbol: "005930", timeframe: "5m", bars: [{ endMs: 1699920300000, open: 70000, high: 71000, low: 69000, close: 70500, volume: 10000 }], totalBars: 1, truncated: false, revision: "1", gaps: [] } }));
  await page.goto("/trading");
  await page.getByRole("button", { name: "삼성전자 (005930)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("72,000원");
  await expect(dialog).toContainText("제공 시각");
  await expect(dialog).toContainText("오래된 시세");
  await expect(dialog).toContainText("이전에 수집된 시세");
  await expect(dialog.getByRole("img", { name: /가격 캔들/ })).toBeVisible();
  const before = quotes;
  await page.clock.runFor(5100);
  await expect.poll(() => quotes).toBeGreaterThan(before);
  await dialog.getByRole("button", { name: "Close" }).click();
  const closed = quotes;
  await page.clock.runFor(5100);
  expect(quotes).toBe(closed);
});
