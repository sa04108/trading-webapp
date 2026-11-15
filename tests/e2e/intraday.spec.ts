import { expect, test } from "@playwright/test";
import { login } from "./login";

const request = {
  mode: "intraday",
  strategyId: "intraday-ema",
  symbol: "005930",
  period: { from: "2026-01-02", to: "2026-01-02" },
  timeframe: "5m",
  initialCash: 10000000,
  parameters: {
    fast: 12,
    slow: 26,
    allocationPct: 95,
    stopLossPct: 3,
    takeProfitPct: 6,
  },
  execution: {
    holdingPolicy: "DAY_ONLY",
    commissionBps: 1.5,
    taxBps: 20,
    slippageBps: 5,
    latencyMs: 1000,
    orderExpiryMinutes: 3,
    maxParticipationPct: 1,
  },
};
const at = Date.parse("2026-01-02T00:05:00Z");
const result = {
  request,
  strategyVersion: "1.0.0",
  dataRevision: "test",
  quoteScope: "TOSS_UNSPECIFIED",
  adjusted: false,
  session: "09:00–15:20 Asia/Seoul",
  signals: [{ id: "signal-1", atMs: at + 300000, side: "BUY", reason: "EMA" }],
  orderEvents: [],
  warnings: [],
  processedBars: 1,
  fills: [
    {
      orderId: "order-1",
      signalAtMs: at,
      eligibleAtMs: at + 1000,
      atMs: at + 300000,
      side: "BUY",
      qty: 2,
      price: 70000,
      commission: 21,
      tax: 0,
      reason: "EMA",
    },
  ],
  equity: [{ endMs: at, equity: 10000000, cash: 10000000, quantity: 0 }],
  position: { quantity: 0, averagePrice: 0, lastPrice: 70000 },
  metrics: {
    pnl: 12000,
    returnPct: 0.12,
    totalCosts: 21,
    maxDrawdownPct: -1,
    dailyMaxDrawdownPct: -1,
    sharpe: null,
    completedTrades: 1,
    averageTradePnl: 12000,
    averageHoldingMinutes: 5,
  },
};
const completed = {
  id: "done",
  request,
  status: "COMPLETED",
  error: null,
  createdAtMs: at,
  updatedAtMs: at,
  result,
};

test("수집과 준비 실패를 각 화면에서 확인한다", async ({ page }) => {
  await login(page);
  let collected = false;
  const collection = {
    id: "collect-1",
    symbol: "005930",
    period: request.period,
    status: "FAILED",
    fetchedBars: 0,
    pages: 0,
    oldestEndMs: null,
    error: "수집 연결 실패",
    createdAtMs: at,
    updatedAtMs: at,
  };
  await page.route("**/api/v1/intraday/data", (route) =>
    route.fulfill({
      json: {
        configured: true,
        retentionDays: 365,
        quoteScope: "TOSS_UNSPECIFIED",
        symbols: [],
        collections: collected ? [collection] : [],
      },
    }),
  );
  await page.route("**/api/v1/intraday/symbols?**", (route) =>
    route.fulfill({ json: { symbols: [] } }),
  );
  await page.route("**/api/v1/intraday/chart?**", (route) =>
    route.fulfill({
      json: {
        symbol: "005930",
        timeframe: "5m",
        bars: [],
        revision: "",
        gaps: [],
        totalBars: 0,
        truncated: false,
      },
    }),
  );
  await page.route("**/api/v1/intraday/collections", (route) => {
    collected = true;
    return route.fulfill({ json: collection });
  });
  await page.goto("/datasets/intraday");
  await page.getByLabel("종목 검색 (이름 또는 6자리 코드)").fill("005930");
  await page.getByRole("button", { name: "데이터 수집" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "수집 연결 실패" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/datasets\/intraday/);
  await expect(page.getByRole("button", { name: "수집 취소" })).toHaveCount(0);

  await page.route("**/api/v1/intraday/runs/failed", (route) =>
    route.fulfill({
      json: {
        id: "failed",
        request,
        status: "FAILED",
        error: "데이터 준비 실패",
        createdAtMs: at,
        updatedAtMs: at,
      },
    }),
  );
  await page.goto("/backtests/intraday/failed");
  await expect(
    page.getByRole("alert").filter({ hasText: "데이터 준비 실패" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "실행 취소" })).toHaveCount(0);
});

test("일봉과 분봉 경로를 오가며 결과와 체결 시각을 확인한다", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/v1/intraday/runs/groups", (route) =>
    route.fulfill({ json: { groups: [{ strategyId: "intraday-ema", total: 1 }] } }),
  );
  await page.route("**/api/v1/intraday/runs?**", (route) =>
    route.fulfill({ json: { runs: [{ ...completed, metrics: result.metrics }], total: 1 } }),
  );
  await page.route("**/api/v1/intraday/runs/done", (route) =>
    route.fulfill({ json: completed }),
  );
  let revision = "test";
  await page.route("**/api/v1/intraday/chart?**", (route) =>
    route.fulfill({
      json: {
        symbol: "005930",
        timeframe: "5m",
        revision,
        gaps: [],
        totalBars: 2,
        truncated: false,
        bars: [at + 300000, at + 600000].map((endMs) => ({
          endMs,
          open: 70000,
          high: 71000,
          low: 69000,
          close: 70500,
          volume: 100,
        })),
      },
    }),
  );
  await page.goto("/backtests");
  const checkHeader = async () => {
    const title = await page.getByRole("heading", { name: "백테스트", exact: true }).boundingBox();
    const selector = await page.getByRole("combobox", { name: "백테스트 주기" }).boundingBox();
    const newButton = await page.getByRole("link", { name: "새 백테스트" }).boundingBox();
    expect(title).not.toBeNull();
    expect(selector).not.toBeNull();
    expect(newButton).not.toBeNull();
    if (!title || !selector || !newButton) throw new Error("헤더를 찾을 수 없습니다");
    expect(selector.x - (title.x + title.width)).toBeGreaterThanOrEqual(0);
    expect(selector.x - (title.x + title.width)).toBeLessThanOrEqual(16);
    expect(Math.abs((selector.y + selector.height / 2) - (title.y + title.height / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs((selector.y + selector.height / 2) - (newButton.y + newButton.height / 2))).toBeLessThanOrEqual(2);
    // 기존 헤더 검사는 버튼 위치만 확인해 내부 + 아이콘의 비대칭 여백을 놓쳤다.
    if (page.viewportSize()!.width < 640) {
      const icon = await page.getByRole("link", { name: "새 백테스트" }).locator("svg").boundingBox();
      if (!icon) throw new Error("추가 아이콘을 찾을 수 없습니다");
      expect(newButton.width).toBeGreaterThanOrEqual(44);
      expect(newButton.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(icon.x + icon.width / 2 - newButton.x - newButton.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(icon.y + icon.height / 2 - newButton.y - newButton.height / 2)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };
  await checkHeader();
  await page.getByRole("combobox", { name: "백테스트 주기" }).click();
  await page.getByRole("option", { name: "분봉" }).click();
  await expect(page).toHaveURL(/\/backtests\/intraday$/);
  await checkHeader();
  await page.locator('a[href="/backtests/intraday/done"]').click();
  await expect(page.getByText("12,000원")).toBeVisible();
  await expect(page.getByRole("img", { name: "자산 추이 차트" })).toBeVisible();
  const fillMarker = page.locator('circle[aria-label^="체결 BUY"]');
  await expect(fillMarker).toBeVisible();
  expect(Number(await fillMarker.getAttribute("cx"))).toBeGreaterThan(400);
  await expect(page.locator('path[aria-label^="신호 BUY"]')).toBeVisible();
  revision = "updated";
  await page.getByLabel("봉 주기").selectOption("1m");
  await expect(
    page.getByText("수집 데이터가 갱신되어 실행 당시 차트와 다를 수 있습니다."),
  ).toBeVisible();
  await expect(page.locator('circle[aria-label^="체결 BUY"]')).toHaveCount(0);
  await page.getByRole("button", { name: "체결 및 주문" }).click();
  await expect(
    page.getByRole("columnheader", { name: "신호 시각" }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "체결 시각" }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: /오전 9:05/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /오전 9:10/ })).toBeVisible();
  await page.getByRole("combobox", { name: "백테스트 주기" }).click();
  await page.getByRole("option", { name: "일봉" }).click();
  await expect(page).toHaveURL(/\/backtests$/);
});


test("새 분봉 전략의 설정을 실행하고 복제한다", async ({ page }) => {
  await login(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/v1/intraday/symbols?**", (route) =>
    route.fulfill({ json: { symbols: [] } }),
  );
  await page.route("**/api/v1/intraday/runs", async (route) => {
    if (route.request().method() === "POST") {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { ...completed, id: "created", request: submitted, result: null } });
    }
    return route.fulfill({ json: { runs: [] } });
  });
  await page.route("**/api/v1/intraday/runs/groups", (route) => route.fulfill({ json: { groups: [] } }));
  await page.route("**/api/v1/intraday/runs/created", (route) =>
    route.fulfill({ json: { ...completed, id: "created", request: submitted, result: null } }),
  );
  const strategies = [
    {
      name: "시초가 범위 돌파", id: "intraday-orb", field: "시초 범위 (분)", value: "20",
      parameters: { openingMinutes: 20, entryWindowMinutes: 90, breakoutBps: 10, volumeMultiplier: 1.5, allocationPct: 95, stopLossPct: 1.5, takeProfitPct: 3 },
      fields: ["개장 후 진입 제한 (분)", "돌파 여유 (bps)", "시초 평균 대비 거래량 (배)"],
    },
    {
      name: "VWAP 회복", id: "intraday-vwap-reclaim", field: "추세 EMA (봉)", value: "25",
      parameters: { trendPeriod: 25, volumePeriod: 10, volumeMultiplier: 1.2, allocationPct: 95, stopLossPct: 1.5, takeProfitPct: 3 },
      fields: ["평균 거래량 (봉)", "평균 대비 거래량 (배)"],
    },
    {
      name: "볼린저·RSI 되돌림", id: "intraday-bollinger-rsi", field: "볼린저 기간 (봉)", value: "25",
      parameters: { bandPeriod: 25, bandStdDev: 2, rsiPeriod: 14, oversold: 30, allocationPct: 95, stopLossPct: 1, takeProfitPct: 2 },
      fields: ["표준편차 배수", "RSI 기간 (봉)", "과매도 RSI"],
    },
  ];
  for (const strategy of strategies) {
    submitted = undefined;
    await page.goto("/backtests/intraday");
    await page.getByText("분봉 전략 소개").click();
    await page.getByRole("link", { name: `${strategy.name} 백테스트` }).click();
    await expect(page.getByRole("combobox", { name: "분봉 전략" })).toContainText(strategy.name);
    for (const field of strategy.fields) await expect(page.getByLabel(field, { exact: true })).toBeVisible();
    await page.getByLabel(strategy.field, { exact: true }).fill(strategy.value);
    await page.getByLabel("종목 검색 (이름 또는 6자리 코드)").fill("005930");
    await page.getByRole("button", { name: "백테스트 실행" }).click();
    await expect(page).toHaveURL(/\/backtests\/intraday\/created$/);
    expect(submitted?.strategyId).toBe(strategy.id);
    expect(submitted?.parameters).toEqual(strategy.parameters);
    await page.getByRole("link", { name: "이 설정으로 다시 실행" }).click();
    await expect(page.getByRole("combobox", { name: "분봉 전략" })).toContainText(strategy.name);
    await expect(page.getByLabel(strategy.field, { exact: true })).toHaveValue(strategy.value);
  }
});
