import { expect, test, type Locator, type Page } from "@playwright/test";
import { login } from "./login";
import type { TradingArtifact, TradingSnapshot } from "../../src/shared/schemas/trading";

const snapshot: TradingSnapshot = {
  revision: 17,
  deployment: null,
  dataPreparation: null,
  paperCapital: { initialCashKrw: 100_000_000, canEdit: true },
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

async function expectResponsiveGroups(page: Page, dialog: Locator, first: string, second: string) {
  const a = await dialog.getByRole("heading", { name: first, exact: true }).boundingBox();
  const b = await dialog.getByRole("heading", { name: second, exact: true }).boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  if (page.viewportSize()!.width >= 1024) {
    expect(b!.x).toBeGreaterThan(a!.x + a!.width);
    expect(b!.y).toBeLessThan(a!.y + a!.height);
    expect(a!.y).toBeLessThan(b!.y + b!.height);
  } else {
    expect(b!.y).toBeGreaterThan(a!.y + a!.height);
    expect(b!.x).toBeLessThan(a!.x + a!.width);
    expect(a!.x).toBeLessThan(b!.x + b!.width);
  }
}

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
    const body = route.request().postDataJSON();
    saved = { method: route.request().method(), body };
    current = { ...current, revision: current.revision + 1, paperCapital: { initialCashKrw: body.initialCashKrw ?? current.paperCapital!.initialCashKrw, canEdit: current.paperCapital!.canEdit } };
    return route.fulfill({ json: current });
  });
  await page.goto("/trading");
  await expect(page.getByText(/초기 모의 자금 100,000,000원/)).toBeVisible();
  await page.getByRole("button", { name: "매매 설정" }).click();
  const capital = page.getByLabel("초기 모의자금 (원)", { exact: true });
  const dialog = page.getByRole("dialog", { name: "매매 설정" });
  await expect(dialog.getByLabel("유니버스 시장")).toHaveText("코스피");
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  const save = dialog.getByRole("button", { name: "설정 저장", exact: true });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(close).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
  await expectResponsiveGroups(page, dialog, "전략 및 유니버스", "자금 및 운용 한도");
  await dialog.getByLabel("난수 시드").scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport({ ratio: 1 });
  await expect(close).toBeInViewport({ ratio: 1 });
  await expect(capital).toHaveValue("100000000");
  await capital.fill("150000000");
  const budget = page.getByLabel("운용 예산 (원)", { exact: true });
  await expect(budget).toHaveValue("10000000");
  await budget.fill("27000000");
  const before = reads;
  await page.clock.runFor(5_100);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(budget).toHaveValue("27000000");
  await expect(capital).toHaveValue("150000000");
  current = { ...current, revision: 18, deployment: { ...current.deployment!, id: "deployment-b", budgetKrw: 30_000_000 } };
  await page.clock.runFor(5_100);
  await expect(page.getByRole("alert")).toContainText("작성 중인 입력은 유지했습니다");
  await expect(budget).toHaveValue("27000000");
  await expect(page.getByRole("button", { name: "설정 저장", exact: true })).toBeDisabled();
  expect(saved).toBeUndefined();
  await page.getByRole("button", { name: "최신 설정 불러오기", exact: true }).click();
  await expect(budget).toHaveValue("30000000");
  await expect(capital).toHaveValue("100000000");
  await capital.fill("150000000");
  await budget.fill("31000000");
  await page.getByRole("button", { name: "설정 저장", exact: true }).click();
  await expect.poll(() => saved).toMatchObject({ method: "PUT", body: { budgetKrw: 31_000_000, initialCashKrw: 150_000_000, expectedRevision: 18 } });
  await expect(page.getByText(/초기 모의 자금 150,000,000원/)).toBeVisible();
  current = { ...current, paperCapital: { initialCashKrw: 150_000_000, canEdit: false } };
  await page.clock.runFor(5_100);
  await page.getByRole("button", { name: "매매 설정" }).click();
  await expect(capital).toBeDisabled();
  await expect(page.getByText("진행 중인 주문이 있거나 첫 체결 이후에는 초기 모의자금을 변경할 수 없습니다.")).toBeVisible();
  await expect(budget).toBeEnabled();
  await budget.fill("32000000");
  await page.getByRole("button", { name: "설정 저장", exact: true }).click();
  await expect.poll(() => saved).toMatchObject({ body: { budgetKrw: 32_000_000 } });
  expect((saved as { body: Record<string, unknown> }).body).not.toHaveProperty("initialCashKrw");
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
  await page.route("**/api/v1/trading/activate", (route) => { writes++; current = { ...current, revision: 18, paperCapital: { ...current.paperCapital!, canEdit: false }, deployment: { ...current.deployment!, status: "ACTIVE" } }; return route.fulfill({ json: current }); });
  await page.route("**/api/v1/trading/deactivate", (route) => { writes++; current = { ...current, revision: 19, paperCapital: { ...current.paperCapital!, canEdit: true }, deployment: { ...current.deployment!, status: "INACTIVE" } }; return route.fulfill({ json: current }); });
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
  await expect(page.getByLabel("초기 모의자금 (원)", { exact: true })).toBeDisabled();
  await expect(page.getByText("자동매매 OFF 상태에서 변경할 수 있습니다.")).toBeVisible();
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


test("데이터 복구 상태를 확인하고 실패 후 재시도해도 자동 매매는 꺼져 있다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  const artifact: TradingArtifact = { strategyId: "range-breakout", name: "전략", description: "검증용", version: "1", artifactHash: "a".repeat(64), executionVersion: "b".repeat(64), latest: true, parameterSchema: { type: "object", properties: {} } };
  let current: TradingSnapshot = { ...snapshot, deployment: {
    id: "deployment-a", strategyId: artifact.strategyId, name: artifact.name, version: artifact.version, artifactHash: artifact.artifactHash, status: "INACTIVE", parameters: {}, universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 100 }], rebalanceInterval: { unit: "MONTH", value: 1 } }, timeframe: "1d", budgetKrw: 10_000_000, maxPositions: 10, maxPositionPercent: 10, dailyLossLimitPercent: 3, maxOrderKrw: 1_000_000, maxSlippageBps: 50, randomSeed: 42, sourceJobId: null, createdAtMs: 1, updatedAtMs: 1, activatedAtMs: null, lastDecisionAtMs: null, lastError: "이전 데이터 오류", activity: "대기", latestArtifactHash: artifact.artifactHash, latestVersion: artifact.version,
  } };
  const revisions: number[] = [];
  let activations = 0;
  let reads = 0;
  await page.route("**/api/v1/trading", (route) => { reads++; return route.fulfill({ json: current }); });
  await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [artifact] } }));
  await page.route("**/api/v1/trading/activate", (route) => { activations++; return route.fulfill({ json: current }); });
  await page.route("**/api/v1/trading/prepare", (route) => {
    revisions.push(route.request().postDataJSON().expectedRevision);
    current = { ...current, revision: current.revision + 1, dataPreparation: { status: "RUNNING", message: "005930 자본변동 확인 중" } };
    return route.fulfill({ status: 202, json: current });
  });
  await page.goto("/trading");
  await page.getByRole("button", { name: "데이터 확인·복구" }).click();
  await expect(page.getByRole("button", { name: "데이터 준비 중" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "자동 매매 OFF" })).toBeDisabled();
  expect(revisions).toEqual([17]);
  const before = reads;
  current = { ...current, revision: 19, dataPreparation: { status: "FAILED", message: "005930 2024: 자본변동 결손" }, deployment: { ...current.deployment!, lastError: "005930 2024: 자본변동 결손" } };
  await page.clock.runFor(5_100);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(page.getByText("005930 2024: 자본변동 결손", { exact: false })).toHaveCount(1);
  await page.getByRole("button", { name: "데이터 복구 재시도" }).click();
  await expect(page.getByRole("button", { name: "데이터 준비 중" })).toBeDisabled();
  expect(revisions).toEqual([17, 19]);
  current = { ...current, revision: 21, dataPreparation: { status: "READY", message: "전체 입력 확인 완료" }, deployment: { ...current.deployment!, lastError: null } };
  await page.clock.runFor(5_100);
  await expect(page.getByText(/전체 입력 확인 완료/)).toBeVisible();
  await expect(page.getByRole("button", { name: "자동 매매 OFF" })).toBeEnabled();
  expect(activations).toBe(0);
});

// 실제 저장소에서 계좌를 두 개 만들고 선택한 계좌만 수정한다.
test("모의투자를 만들고 계좌별 자금과 설정을 분리한다", async ({ page }, testInfo) => {
  await login(page);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const first = `첫 계좌 ${suffix}`;
  const second = `둘째 계좌 ${suffix}`;
  await page.goto("/trading");
  const create = async (title: string, capital: string, market = "코스피+코스닥") => {
    await page.getByRole("button", { name: "새 모의투자" }).click();
    const marketSelect = page.getByLabel("유니버스 시장");
    await expect(marketSelect).toHaveText("코스피+코스닥");
    await marketSelect.click();
    await expect(page.getByRole("option")).toHaveText(["코스피+코스닥", "코스피", "코스닥"]);
    await page.getByRole("option", { name: market, exact: true }).click();
    await page.getByLabel("모의투자 이름 (선택)").fill(title);
    await page.getByLabel("초기 모의자금 (원)").fill(capital);
    const response = page.waitForResponse((res) => res.url().endsWith("/api/v1/trading/presets") && res.request().method() === "POST");
    await page.getByRole("button", { name: "설정 저장" }).click();
    const result = await response;
    expect(result.status()).toBe(201);
    const body = await result.json() as { id: string };
    await expect(page).toHaveURL(new RegExp(`presetId=${body.id}`));
    return body.id;
  };
  const firstId = await create(first, "11000000");
  await expect(page.getByText(/초기 모의 자금 11,000,000원/)).toBeVisible();
  const secondId = await create(second, "22000000", "코스닥");
  await expect(page.getByText(/초기 모의 자금 22,000,000원/)).toBeVisible();
  await page.goto("/");
  const firstLink = page.getByRole("link", { name: `${first} · 꺼짐` });
  const secondLink = page.getByRole("link", { name: `${second} · 꺼짐` });
  await expect(firstLink).toBeVisible();
  await expect(secondLink).toBeVisible();
  await firstLink.click();
  await expect(page).toHaveURL(new RegExp(`presetId=${firstId}`));
  await expect(page.getByText(/초기 모의 자금 11,000,000원/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("모의투자 선택").selectOption(secondId);
  await expect(page.getByText(/초기 모의 자금 22,000,000원/)).toBeVisible();
  await page.getByRole("button", { name: "매매 설정" }).click();
  await expect(page.getByLabel("모의투자 이름 (선택)")).toHaveValue(second);
  await page.getByLabel("운용 예산 (원)").fill("9000000");
  const saved = page.waitForResponse((res) => res.request().method() === "PUT" && new URL(res.url()).pathname === "/api/v1/trading/strategy");
  await page.getByRole("button", { name: "설정 저장" }).click();
  const result = await saved;
  expect(result.status()).toBe(200);
  expect(new URL(result.url()).searchParams.get("presetId")).toBe(secondId);
  const firstSnapshot = await (await page.request.get(`/api/v1/trading?presetId=${firstId}`)).json() as TradingSnapshot;
  const secondSnapshot = await (await page.request.get(`/api/v1/trading?presetId=${secondId}`)).json() as TradingSnapshot;
  expect(firstSnapshot.deployment).toMatchObject({ title: first, budgetKrw: 10_000_000, universeRule: { markets: ["KOSPI", "KOSDAQ"] } });
  expect(secondSnapshot.deployment).toMatchObject({ title: second, budgetKrw: 9_000_000, universeRule: { markets: ["KOSDAQ"] } });
  expect(firstSnapshot.paperCapital?.initialCashKrw).toBe(11_000_000);
  expect(secondSnapshot.paperCapital?.initialCashKrw).toBe(22_000_000);
  const defaultSnapshot = await (await page.request.get("/api/v1/trading")).json() as TradingSnapshot;
  if (defaultSnapshot.deployment) {
    const selector = page.getByLabel("모의투자 선택");
    await expect(selector.locator(`option[value="${defaultSnapshot.deployment.id}"]`)).toHaveCount(1);
    await expect(selector.locator('option[value=""]')).toHaveCount(0);
  }
});

// 분봉 계좌에서는 원본 설정만 표시하고 일봉 전용 변경 동작을 제공하지 않는다.
test("분봉 모의투자는 고정 설정을 표시하고 확인 후 켠다", async ({ page }) => {
  await login(page);
  let current: TradingSnapshot = { ...snapshot, deployment: {
    id: "minute-preset", kind: "intraday", name: "분봉 전략", strategyId: "intraday-ema", version: "1", status: "INACTIVE",
    timeframe: "5m", sourceRunId: "run-1", executionVersion: "execution-1", createdAtMs: 1, updatedAtMs: 1,
    activatedAtMs: null, lastDecisionAtMs: null, lastError: null, activity: "대기",
    request: { mode: "intraday", strategyId: "intraday-ema", symbol: "005930", timeframe: "5m", period: { from: "2026-01-02", to: "2026-01-02" }, initialCash: 10_000_000,
      parameters: { fast: 12, slow: 26, allocationPct: 95, stopLossPct: 3, takeProfitPct: 6 },
      execution: { holdingPolicy: "DAY_ONLY", commissionBps: 1.5, taxBps: 20, slippageBps: 5, latencyMs: 1000, orderExpiryMinutes: 3, maxParticipationPct: 1 } },
  } };
  await page.route("**/api/v1/trading?presetId=minute-preset", (route) => route.fulfill({ json: current }));
  await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [] } }));
  await page.route("**/api/v1/trading/activate?presetId=minute-preset", (route) => {
    current = { ...current, revision: 18, deployment: { ...current.deployment!, status: "ACTIVE" } };
    return route.fulfill({ json: current });
  });
  await page.goto("/trading?presetId=minute-preset");
  await expect(page.getByText(/확정된 1분 OHLCV로 모의 체결/)).toBeVisible();
  await expect(page.getByRole("button", { name: "데이터 확인·복구" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "최신 버전으로 변경" })).toHaveCount(0);
  await page.getByRole("button", { name: "매매 설정" }).click();
  const dialog = page.getByRole("dialog", { name: "매매 설정" });
  await expectResponsiveGroups(page, dialog, "고정 전략 파라미터", "고정 체결 조건");
  await expect(dialog.getByRole("button", { name: "이름 저장" })).toBeInViewport({ ratio: 1 });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialog).toContainText("005930");
  await expect(dialog).toContainText("2026-01-02");
  await expect(dialog).toContainText("수수료 1.5bps");
  await expect(dialog.getByRole("button", { name: "설정 저장" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "자동 매매 OFF" }).click();
  await page.getByRole("button", { name: "켜기", exact: true }).click();
  await expect(page.getByRole("button", { name: "자동 매매 ON" })).toBeVisible();
});
