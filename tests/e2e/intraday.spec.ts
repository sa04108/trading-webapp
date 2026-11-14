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
  await page.route("**/api/v1/intraday/runs", (route) =>
    route.fulfill({ json: { runs: [completed] } }),
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
  await page.getByRole("link", { name: "분봉", exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/intraday$/);
  await page.getByRole("link", { name: /005930/ }).click();
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
  await page.getByRole("link", { name: "일봉", exact: true }).click();
  await expect(page).toHaveURL(/\/backtests$/);
});
