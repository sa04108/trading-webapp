import { expect, test } from "@playwright/test";
import { login } from "./login";
import type { TradingArtifact, TradingSnapshot } from "../../src/shared/schemas/trading";

const accounts = [
  { id: "account-1", label: "계좌 1" },
  { id: "account-2", label: "계좌 2" },
  { id: "account-3", label: "계좌 3" },
];
const snapshot = {
  revision: 17,
  deployment: null,
  broker: {
    provider: "TOSS",
    configured: true,
    accounts,
    selectedAccountId: "account-2",
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

// 계좌 선택 검증은 다른 화면의 전략 교체가 작성 중인 초안을 덮는 경로를 실행하지 않는다.
test("전략이 외부에서 교체되어도 초안을 유지하고 명시적 새로 불러오기 뒤 저장한다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  const artifact: TradingArtifact = { strategyId: "range-breakout", name: "전략", description: "검증용",
    version: "1", artifactHash: "a".repeat(64), executionVersion: "b".repeat(64), latest: true,
    parameterSchema: { type: "object", properties: {} } };
  let current: TradingSnapshot = { ...snapshot, broker: { ...snapshot.broker, provider: "TOSS" }, deployment: {
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

test("계좌 목록을 아래로 열고 키보드로 선택한다", async ({ page }) => {
  await login(page);
  let current = snapshot;
  await page.route("**/api/v1/trading", (route) => route.fulfill({ json: current }));
  await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [] } }));
  let submitted: unknown;
  await page.route("**/api/v1/trading/account", (route) => {
    submitted = { method: route.request().method(), body: route.request().postDataJSON() };
    current = { ...snapshot, revision: 18, broker: { ...snapshot.broker, selectedAccountId: "account-3" } };
    return route.fulfill({ json: current });
  });
  await page.goto("/trading");
  // Radix 메뉴가 열리면 배경 트리거가 접근성 트리에서 숨겨져도 화면 좌표는 확인한다.
  const trigger = page.getByRole("combobox", { name: "계좌 선택", includeHidden: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  if (!triggerBox || !menuBox) throw new Error("계좌 선택기를 찾을 수 없습니다");
  expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 1);
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => submitted).toEqual({ method: "PUT", body: { expectedRevision: 17, accountId: "account-3" } });
  await expect(trigger).toContainText("계좌 3");
});
