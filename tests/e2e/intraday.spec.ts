import { expect, test } from "@playwright/test";
import { login } from "./login";
import { buildPeriodValidationPlan, type PeriodValidationConfig, type PeriodValidationDto } from "../../src/shared/schemas/period-validation";
import { intradayRequestSchema } from "../../src/shared/schemas/intraday";
import type { IntradayResult } from "../../src/shared/schemas/intraday";
import { buildIntradayDailyReport } from "../../src/runtime/modules/intraday/domain/daily-evaluation";
import { RISK_FREE_RATE_SEED } from "../../src/runtime/modules/backtest/domain/risk-free-rate-seed";

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
    ...[2, 3].map((offset) => ({ orderId: "order-2", signalAtMs: at + 300000,
      eligibleAtMs: at + 301000, atMs: at + offset * 300000, side: "SELL", qty: 1,
      price: 71000, commission: 10.65, tax: 142, reason: "TAKE_PROFIT" })),
  ],
  equity: [{ endMs: at, equity: 10000000, cash: 10000000, quantity: 0 }, { endMs: at + 900000, equity: 10001673.7, cash: 10001673.7, quantity: 0 }],
  position: { quantity: 0, averagePrice: 0, lastPrice: 70000 },
  metrics: {
    pnl: 1673.7,
    returnPct: 0.016737,
    totalCosts: 326.3,
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

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/intraday/experiments/summary?**", (route) => {
    const ids = new URL(route.request().url()).searchParams.get("jobIds")!.split(",");
    const returns = { count: 0, mean: null, sampleStdDev: null };
    return route.fulfill({ json: { summaries: ids.map(jobId => ({ jobId, validation: { experimentCount: 0, activeCount: 0, completedCount: 0, returns, modes: { HOLDOUT: 0, WALK_FORWARD: 0 } } })) } });
  });
  await page.route("**/api/v1/intraday/runs/*/lineage", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    return route.fulfill({ json: { kind: "original", complete: true, roleLabel: "결과", items: [{ label: "백테스트", href: "/backtests" }, { label: "분봉", href: "/backtests/intraday" }, { label: `결과 ${id.slice(-6)}`, href: `/backtests/intraday/${id}` }] } });
  });
});

// 정적 마크업 검사는 구간 전환 중 이전 성과가 남거나 모든 분봉 본문을 요청하는 회귀를 잡지 못한다.
test("분봉 일별 검증은 선택한 OOS만 조회하고 조기 종료를 별도로 표시한다", async ({ page }) => {
  await login(page);
  const sourceRequest = intradayRequestSchema.parse({ ...request, timeframe: "15m", parameters: { ...request.parameters, fast: 4, slow: 10 }, period: { from: "2026-04-01", to: "2026-08-31" } });
  function report(dates: string[], early: boolean) {
    const equity: IntradayResult["equity"] = [];
    let cash = sourceRequest.initialCash;
    for (const [i, date] of dates.entries()) {
      if (early && i === 2) break;
      const closing = cash * (1 + (early ? [0.2, -0.7][i]! : [1, 0, -0.5][i]!) / 100);
      for (let minute = 1; minute <= 380; minute++) equity.push({ endMs: Date.parse(`${date}T09:00:00+09:00`) + minute * 60_000, cash, equity: minute === 380 ? closing : cash, quantity: early && i === 1 ? 12 : 0 });
      cash = closing;
    }
    return buildIntradayDailyReport({ request: sourceRequest, equity, fills: [], position: { quantity: early ? 12 : 0, averagePrice: 70000, lastPrice: 70000 } }, dates, 380, RISK_FREE_RATE_SEED);
  }
  const reports = [report(["2026-07-01", "2026-07-02", "2026-07-03"], false), report(["2026-08-03", "2026-08-04", "2026-08-05"], true)];
  const folds = reports.map((r, ordinal) => ({ ordinal, train: { from: "2026-04-01", to: "2026-06-30" }, test: { from: r.days[0]!.date, to: r.days.at(-1)!.date } }));
  const experiment: PeriodValidationDto = {
    id: "daily-validation", sourceJobId: "done", status: "COMPLETED", config: { mode: "WALK_FORWARD", trainMonths: 3, testMonths: 1 },
    plan: { folds, candidates: [sourceRequest.parameters], totalRuns: 4, unusedPeriod: null }, initialCash: sourceRequest.initialCash, createdAtMs: at, error: null,
    trials: folds.map((fold) => ({ id: `trial-${fold.ordinal}`, fold: fold.ordinal, role: "OOS", candidate: 0, period: fold.test, parameters: sourceRequest.parameters, jobId: `result-${fold.ordinal}`, status: "COMPLETED", progress: null, error: null, skipReason: null, selection: null,
      metrics: { totalReturnPct: fold.ordinal ? -0.5 : 0.495, cagrPct: null, maxDrawdownPct: -0.7, sharpe: reports[fold.ordinal]!.summary.sharpe, tradeCount: 0, intradayDaily: reports[fold.ordinal]!.summary } })),
  };
  await page.route("**/api/v1/intraday/runs/done", (route) => route.fulfill({ json: { ...completed, request: sourceRequest } }));
  await page.route("**/api/v1/intraday/validations/daily-validation", (route) => route.fulfill({ json: { experiment } }));
  const reads: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/intraday/validations/daily-validation/trials/*/daily", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    reads.push(id);
    if (id === "trial-1") await held;
    await route.fulfill({ json: { report: reports[id === "trial-0" ? 0 : 1] } });
  });
  await page.goto("/backtests/intraday/validations/daily-validation");
  await expect(page.getByText(/정상 평가 3 \/ 3일/)).toBeVisible();
  expect(reads).toEqual(["trial-0"]);
  const stats = page.locator('[aria-label="OOS 일별 핵심 지표"]');
  await expect(stats).toContainText("+0.17%");
  await page.getByLabel("평가할 OOS 구간").click();
  await page.getByRole("option", { name: /2회차/ }).click();
  await expect(page.getByText("일별 성과를 불러오는 중…")).toBeVisible();
  await expect(stats).toHaveCount(0);
  release();
  await expect(page.getByText(/청산 실패로 조기 종료 \(잔여 12주\)/)).toBeVisible();
  await expect(stats).toContainText("+0.20%");
  await page.getByText("평가에서 제외된 날짜", { exact: true }).click();
  await expect(page.getByRole("cell", { name: "미실행", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "청산 실패", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: /-70,140원/ })).toBeVisible();
  expect(reads).toEqual(["trial-0", "trial-1"]);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel("평가할 OOS 구간").click();
  await page.getByRole("option", { name: /1회차/ }).click();
  await expect(stats).toContainText("+0.17%");
  expect(reads).toEqual(["trial-0", "trial-1"]);
});

// 빈 차트만 검사하면 수집 폴링이 확대·이동한 차트를 다시 만드는 회귀를 잡지 못한다.
test("수집 폴링은 차트와 스크롤을 유지하고 사용자 조회는 최신 데이터를 가져온다", async ({ page }) => {
  await login(page);
  const stock = { symbol: "005930", name: "삼성전자", market: "KOSPI" };
  let polls = 0;
  let releasePoll: (() => void) | undefined;
  const requests: string[] = [];
  await page.route("**/api/v1/symbols/library**", (route) => route.fulfill({ json: { favorites: [stock], recent: [] } }));
  await page.route("**/api/v1/intraday/data", async (route) => {
    const poll = polls++;
    if (poll > 0) await new Promise<void>((resolve) => { releasePoll = resolve; });
    const status = poll === 0 ? "QUEUED" : poll < 3 ? "RUNNING" : "COMPLETED";
    await route.fulfill({ json: {
      configured: true, retentionDays: 365, quoteScope: "TOSS_UNSPECIFIED",
      symbols: [{ symbol: stock.symbol, bars: 150 + poll, firstEndMs: at, lastEndMs: at + 149 * 300000, revision: `revision-${poll}`, updatedAtMs: at }],
      collections: [{ id: "collect-1", symbol: stock.symbol, period: request.period, status, fetchedBars: 150, pages: 1, oldestEndMs: at, error: null, createdAtMs: at, updatedAtMs: at }],
    } });
  });
  await page.route("**/api/v1/intraday/chart?**", (route) => {
    const timeframe = new URL(route.request().url()).searchParams.get("timeframe")!;
    requests.push(timeframe);
    const price = 70000 + requests.length * 1000;
    const bars = Array.from({ length: 150 }, (_, i) => ({ endMs: at + i * 300000, open: price + i, high: price + i + 20, low: price + i - 20, close: price + i + 10, volume: 1000 + i }));
    return route.fulfill({ json: { symbol: stock.symbol, timeframe, bars, revision: `chart-${requests.length}`, gaps: [], totalBars: bars.length, truncated: false } });
  });
  await page.goto("/datasets/intraday?symbol=005930");
  const status = page.getByRole("status", { name: "분봉 수집 상태" });
  await expect(status).toHaveText(/수집 대기/);
  await expect(page.getByText("71,159원", { exact: true })).toBeVisible();
  const chart = page.getByRole("img", { name: /가격 캔들 및 거래량 차트/ });
  await chart.scrollIntoViewIfNeeded();
  const canvas = chart.locator("canvas").first();
  const bitmap = () => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const before = await bitmap();
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.wheel(0, -300);
  await page.mouse.move(0, 0);
  await expect.poll(bitmap).not.toBe(before);
  const zoomed = await bitmap();
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 100, { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(0, 0);
  await expect.poll(bitmap).not.toBe(zoomed);
  const moved = await bitmap();
  const scroll = await page.evaluate(() => window.scrollY);
  expect(scroll).toBeGreaterThan(0);
  const node = await canvas.elementHandle();
  for (let poll = 1; poll <= 3; poll++) {
    await expect.poll(() => polls).toBeGreaterThan(poll);
    const release = releasePoll!;
    releasePoll = undefined;
    release();
    if (poll < 3) await expect(status).toHaveText(/수집 중/);
    else await expect(status).toBeEmpty();
    await expect(page.getByText(new RegExp(`보관 범위:.*${150 + poll}개`))).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll);
    expect(await bitmap()).toBe(moved);
    expect(await canvas.evaluate((element, original) => element === original, node)).toBe(true);
    expect(requests).toEqual(["5m"]);
    await expect(page.getByText("71,159원", { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "1분", exact: true }).click();
  await expect(page.getByText("72,159원", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "5분", exact: true }).click();
  await expect(page.getByText("73,159원", { exact: true })).toBeVisible();
  expect(requests).toEqual(["5m", "1m", "5m"]);
  await page.getByRole("button", { name: "1주", exact: true }).click();
  await expect(page.getByText("74,159원", { exact: true })).toBeVisible();
  expect(requests).toEqual(["5m", "1m", "5m", "5m"]);
});

test("수집과 준비 실패를 각 화면에서 확인한다", async ({ page }) => {
  await login(page);
  let collected = false;
  let favorite = false;
  let viewed = false;
  const stock = { symbol: "005930", name: "삼성전자", market: "KOSPI" };
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
    route.fulfill({ json: { symbols: [stock] } }),
  );
  await page.route("**/api/v1/symbols/library**", (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      if (body.favorite !== undefined) favorite = body.favorite;
      if (body.viewed) viewed = true;
    }
    return route.fulfill({ json: { favorites: favorite ? [stock] : [], recent: viewed ? [stock] : [] } });
  });
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
  await page.getByRole("button", { name: /삼성전자 005930/ }).click();
  await expect(page.getByRole("tab", { name: "관심 종목" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "관심 종목 추가", exact: true }).click();
  await expect(page.getByRole("button", { name: "삼성전자 관심 종목 해제" })).toBeVisible();
  await page.getByRole("tab", { name: "최근 조회 종목" }).click();
  await expect(page.getByRole("tab", { name: "최근 조회 종목" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /삼성전자 005930/ })).toBeVisible();
  await page.getByRole("button", { name: "1주", exact: true }).click();
  const startDate = await page.getByLabel("시작일").inputValue();
  const endDate = await page.getByLabel("종료일").inputValue();
  expect(Date.parse(endDate) - Date.parse(startDate)).toBe(6 * 86400000);
  await page.getByRole("button", { name: "데이터 수집" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "수집 시작" }).click();
  await expect(page.getByText("분봉 데이터 수집을 시작했습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "작업 보기" })).toBeVisible();
  await expect(page.getByText("수집 연결 실패")).toHaveCount(0);
  await expect(page).toHaveURL(/\/datasets\/intraday/);
  await expect(page.getByRole("button", { name: "수집 취소" })).toHaveCount(0);

  // 기존 실패 화면 검사만으로는 응답 대기·준비·계산 중 피드백의 누락을 잡을 수 없다.
  let phase = "QUEUED";
  let release!: () => void;
  const responseReady = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/intraday/runs/failed", async (route) => {
    await responseReady;
    return route.fulfill({ json: {
      id: "failed", request, status: phase,
      error: phase === "FAILED" ? "데이터 준비 실패" : null,
      createdAtMs: at, updatedAtMs: at,
    } });
  });
  await page.goto("/backtests/intraday/failed");
  await expect(page.getByRole("status", { name: "백테스트 불러오는 중" })).toBeVisible();
  release();
  const progress = page.getByRole("status", { name: "백테스트 실행 상태" });
  await expect(progress).toContainText("실행 순서를 기다리고 있습니다.");
  phase = "PREPARING";
  await expect(progress).toContainText("필요한 데이터를 수집하고 있습니다.");
  phase = "RUNNING";
  await expect(progress).toContainText("분봉으로 전략을 계산하고 있습니다.");
  await expect(progress.getByRole("progressbar")).toHaveCount(0);
  phase = "FAILED";
  await expect(page.getByRole("alert").filter({ hasText: "데이터 준비 실패" })).toBeVisible();
  await expect(progress).toHaveCount(0);
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
    route.fulfill({ json: { ...completed, result: { ...result, metrics: { ...result.metrics, sharpe: -0.5 }, warnings: ["분봉 1개(1구간)가 누락되었습니다. 누락 구간에서는 신호·체결을 만들지 않습니다."] } } }),
  );
  let revision = "test";
  await page.route("**/api/v1/intraday/chart?**", (route) =>
    route.fulfill({
      json: {
        symbol: "005930",
        timeframe: "5m",
        revision,
        gaps: [{ fromMs: at - 60000, toMs: at, missingMinutes: 1 }],
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
  await expect(page.getByText("+1,674원", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "EMA 교차", exact: true })).toBeVisible();
  await expect(page.getByText("완료", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "그대로 복제", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "설정 탐색 실험", exact: true })).toHaveAttribute("href", "/backtests/intraday/done/search");
  await expect(page.getByRole("link", { name: "재설정 및 복제", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Export", exact: true })).toHaveAttribute("href", "/api/v1/intraday/runs/done/export");
  // 기존 시각 확인만으로는 부분청산 집계·공통 표·비용 패널 배치의 회귀를 잡지 못한다.
  await expect(page.getByText("매도 체결 수 (부분청산 포함)", { exact: true }).locator("..")).toContainText("2건");
  await expect(page.getByText("승률 (매도 체결 기준)", { exact: true }).locator("..")).toContainText("100.0%");
  const costPanel = page.getByLabel("비용 및 보유기간");
  const columns = costPanel.locator(":scope > div");
  const left = await columns.nth(0).boundingBox(), right = await columns.nth(1).boundingBox();
  expect(left && right && Math.abs(left.width - right.width)).toBeLessThanOrEqual(1);
  expect(left && right && Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
  // 공통 색상 함수 검사와 별도로 상세 화면에 적용한 값과 색상을 확인한다.
  await expect(page.getByText("Sharpe", { exact: true }).locator("..").locator("p").last()).toHaveClass(/text-loss/);
  await expect(page.getByText("MDD", { exact: true }).locator("..").locator("p").last()).toHaveText("-1.00%");
  await expect(page.getByText("MDD", { exact: true }).locator("..").locator("p").last()).toHaveClass(/text-loss/);
  // 완료된 계산의 누락 경고가 결과와 차트에서 모두 보이는지 확인한다.
  await expect(page.getByRole("alert").filter({ hasText: "분봉 1개(1구간)가 누락" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "누락 구간에서는 매매를 시뮬레이션하지 않습니다" })).toBeVisible();
  const equity = page.getByRole("img", { name: /자산 곡선 차트/ });
  await equity.scrollIntoViewIfNeeded();
  await expect(equity).toBeVisible();
  const markers = page.getByRole("list", { name: "차트 신호 및 체결", includeHidden: true });
  await expect(markers).toContainText("신호 BUY");
  await expect(markers).toContainText("체결 BUY");
  await expect(page.getByRole("img", { name: /가격 캔들 및 거래량 차트/ })).toBeVisible();
  revision = "updated";
  await page.getByRole("combobox", { name: "봉 주기" }).click();
  await page.getByRole("option", { name: "1분", exact: true }).click();
  await expect(
    page.getByText("수집 데이터가 갱신되어 실행 당시 차트와 다를 수 있습니다."),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "차트 신호 및 체결", includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "체결 및 주문" })).toHaveCount(0);
  await page.getByText("거래 내역", { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("columnheader", { name: /진입가 \(원\)/ })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /매도가 \(원\)/ })).toBeAttached();
  await expect(page.getByRole("columnheader", { name: "비용 (원)", exact: true })).toBeAttached();
  await expect(page.getByRole("cell", { name: /2026.01.02 09:10/ })).toHaveCount(2);
  await expect(page.getByRole("cell", { name: /2026.01.02 09:15/ })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const notes = page.getByLabel("시세 및 체결 참고");
  await expect(notes).toContainText("슬리피지를 다시 차감하지 않습니다");
  await page.getByRole("navigation", { name: "백테스트 경로" }).getByRole("link", { name: "백테스트", exact: true }).click();
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
      parameters: { maxDailyEntries: 1, cooldownMinutes: 30, maxHoldingMinutes: 120, openingMinutes: 20, entryWindowMinutes: 150, breakoutBps: 5, volumeMultiplier: 1, allocationPct: 50, stopLossPct: 1.5, takeProfitPct: 3 },
      timeframe: "5분",
      fields: ["개장 후 진입 제한 (분)", "돌파 여유 (bps)", "시초 평균 대비 거래량 (배)"],
    },
    {
      name: "VWAP 회복", id: "intraday-vwap-reclaim", field: "추세 EMA (봉)", value: "10",
      parameters: { maxDailyEntries: 2, cooldownMinutes: 30, maxHoldingMinutes: 120, trendPeriod: 10, volumePeriod: 4, volumeMultiplier: 1.3, allocationPct: 50, stopLossPct: 1.5, takeProfitPct: 3 },
      timeframe: "15분",
      fields: ["평균 거래량 (봉)", "평균 대비 거래량 (배)"],
    },
    {
      name: "볼린저·RSI 되돌림", id: "intraday-bollinger-rsi", field: "볼린저 기간 (봉)", value: "25",
      parameters: { maxDailyEntries: 2, cooldownMinutes: 30, maxHoldingMinutes: 60, bandPeriod: 25, bandStdDev: 1.8, rsiPeriod: 7, oversold: 35, recoveryBars: 3, allocationPct: 40, stopLossPct: 1, takeProfitPct: 2 },
      timeframe: "5분",
      fields: ["표준편차 배수", "RSI 기간 (봉)", "과매도 RSI", "회복 대기 (봉)"],
    },
    {
      name: "EMA 교차", id: "intraday-ema", field: "단기 EMA", value: "5",
      parameters: { maxDailyEntries: 2, cooldownMinutes: 30, maxHoldingMinutes: 120, fast: 5, slow: 10, volumePeriod: 4, volumeMultiplier: 1.3, allocationPct: 50, stopLossPct: 1.5, takeProfitPct: 3 },
      timeframe: "15분",
      fields: ["장기 EMA", "평균 거래량 (봉)", "평균 대비 거래량 (배)"],
    },
  ];
  for (const strategy of strategies) {
    submitted = undefined;
    await page.goto("/backtests/intraday");
    await page.getByText("분봉 전략 소개").click();
    await page.getByRole("link", { name: `${strategy.name} 백테스트` }).click();
    await expect(page.getByRole("combobox", { name: "분봉 전략" })).toContainText(strategy.name);
    await expect(page.getByRole("combobox", { name: "봉 주기" })).toContainText(strategy.timeframe);
    for (const field of [...strategy.fields, "하루 최대 진입 (회)", "청산 후 재진입 대기 (분)", "최대 보유 (분)"]) await expect(page.getByLabel(field, { exact: true })).toBeVisible();
    if (strategy.timeframe === "15분") {
      await page.getByRole("combobox", { name: "봉 주기" }).click();
      await expect(page.getByRole("option", { name: "5분", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await page.getByLabel(strategy.field, { exact: true }).fill(strategy.value);
    await page.getByLabel("종목 검색 (이름 또는 6자리 코드)").fill("005930");
    await page.getByRole("button", { name: "백테스트 실행" }).click();
    await expect(page).toHaveURL(/\/backtests\/intraday\/created$/);
    expect(submitted?.strategyId).toBe(strategy.id);
    expect(submitted?.parameters).toEqual(strategy.parameters);
    await page.getByRole("link", { name: "재설정 및 복제" }).click();
    await expect(page.getByRole("combobox", { name: "분봉 전략" })).toContainText(strategy.name);
    await expect(page.getByLabel(strategy.field, { exact: true })).toHaveValue(strategy.value);
  }
});


test("이전 EMA 복제는 기존 봉 주기를 보여주고 새 실행 전에 변경을 요구한다", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/intraday/runs/done", (route) => route.fulfill({ json: completed }));
  await page.route("**/api/v1/intraday/symbols?**", (route) => route.fulfill({ json: { symbols: [] } }));
  await page.goto("/backtests/intraday/new?clone=done");
  const timeframe = page.getByRole("combobox", { name: "봉 주기" });
  await expect(timeframe).toContainText("5분 (기존 설정 · 변경 필요)");
  await expect(page.getByLabel("장기 EMA", { exact: true })).toHaveValue("26");
  await page.getByRole("button", { name: "백테스트 실행" }).click();
  await expect(page.getByRole("alert")).toContainText("15분봉");
  await timeframe.click();
  await page.getByRole("option", { name: "15분", exact: true }).click();
  await expect(page.getByLabel("장기 EMA", { exact: true })).toHaveValue("26");
});


// 분봉 기록 삭제는 취소 API와 구분해야 하며, 접힌 전략·다른 페이지·실행 중 기록을 건드리면 안 된다.
test("분봉 편집은 현재 페이지의 종료된 이력만 삭제한다", async ({ page }) => {
  await login(page);
  const runs = Array.from({ length: 13 }, (_, i) => ({
    ...completed, result: undefined, id: `history-${i}`,
    request: { ...request, strategyId: i === 12 ? "intraday-orb" : "intraday-ema" },
    status: i === 0 ? "RUNNING" : "COMPLETED", createdAtMs: at + i * 60000,
    metrics: i === 0 ? null : result.metrics,
  }));
  const deleted: string[] = [];
  await page.route("**/api/v1/intraday/runs/groups", (route) => route.fulfill({ json: {
    groups: ["intraday-ema", "intraday-orb"].map((strategyId) => ({
      strategyId, total: runs.filter((r) => r.request.strategyId === strategyId && !deleted.includes(r.id)).length,
    })),
  } }));
  await page.route("**/api/v1/intraday/runs?**", (route) => {
    const q = new URL(route.request().url()).searchParams;
    const rows = runs.filter((r) => r.request.strategyId === q.get("strategyId") && !deleted.includes(r.id));
    const offset = Number(q.get("offset")), limit = Number(q.get("limit"));
    return route.fulfill({ json: { runs: rows.slice(offset, offset + limit), total: rows.length } });
  });
  await page.route("**/api/v1/backtests/deletion-preview", (route) => route.fulfill({ json: { backtestCount: 2, configurationSearchCount: 0, periodValidationCount: 0, blockers: [], token: "preview" } }));
  await page.route("**/api/v1/backtests/delete", (route) => {
    const { ids, mode, token } = route.request().postDataJSON() as { ids: string[]; mode: string; token: string };
    expect(mode).toBe("intraday"); expect(token).toBe("preview"); deleted.push(...ids);
    return route.fulfill({ status: 204 });
  });
  await page.goto("/backtests/intraday?view=table&page.intraday-ema=2");
  const group = page.locator("section").filter({ has: page.getByRole("heading", { name: "EMA 교차", exact: true }) });
  const other = page.locator("section").filter({ has: page.getByRole("heading", { name: "시초가 범위 돌파", exact: true }) });
  await expect(group.locator("tbody > tr")).toHaveCount(2);
  await expect(other.locator("tbody > tr")).toHaveCount(1);
  const view = page.getByRole("switch", { name: "카드 보기" });
  await group.getByRole("button", { name: "편집", exact: true }).click();
  await expect(other.getByRole("button", { name: "편집", exact: true })).toBeVisible();
  await expect(other.getByRole("checkbox")).toHaveCount(0);
  await group.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await group.getByRole("button", { name: "삭제 (2)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("백테스트 결과 2개");
  await expect(dialog).not.toContainText("설정 탐색 실험");
  await expect(dialog).not.toContainText("기간검증");
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect.poll(() => [...deleted].sort()).toEqual(["history-10", "history-11"]);
  await expect(group.locator("tbody > tr")).toHaveCount(10);
  await expect(group.getByRole("button", { name: "편집", exact: true })).toBeVisible();
  await expect(other.locator("tbody > tr")).toHaveCount(1);
  await group.getByRole("button", { name: "편집", exact: true }).click();
  await expect(group.getByRole("row").filter({ hasText: "진행 중" }).getByRole("checkbox")).toBeDisabled();
  await group.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await expect(group.getByRole("button", { name: "삭제 (9)", exact: true })).toBeEnabled();
  await view.click();
  await expect(view).toBeChecked();
  await expect(group.getByRole("button", { name: "삭제 (0)", exact: true })).toBeDisabled();
  const rowCheckboxes = group.getByRole("checkbox", { name: /백테스트 선택$/ });
  await expect(rowCheckboxes).toHaveCount(6);
  await expect(rowCheckboxes.first()).toBeDisabled();
  await expect(other.getByRole("checkbox")).toHaveCount(0);
});

// 일봉 전용 API로 잘못 연결되는 회귀는 공통 검증 폼 테스트만으로 발견할 수 없다.
test("분봉 실험 페이지를 재사용하고 검증 하위 결과와 일반 복제를 구분한다", async ({ page }) => {
  await login(page);
  const sourceRequest = intradayRequestSchema.parse({ ...request, timeframe: "15m", parameters: { ...request.parameters, fast: 4, slow: 10 }, period: { from: "2026-01-05", to: "2026-10-30" } });
  const childRequest = { ...sourceRequest, period: { from: "2026-07-01", to: "2026-10-30" } };
  const source = { ...completed, request: sourceRequest, result: { ...result, request: sourceRequest } };
  let experiment: PeriodValidationDto | null = null;
  let cloneCount = 0;
  const wrongApi: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/backtests/done")) wrongApi.push(r.url()); });
  await page.route("**/api/v1/intraday/runs/done", (route) => route.fulfill({ json: source }));
  await page.route("**/api/v1/intraday/runs/oos", (route) => route.fulfill({ json: { ...source, id: "oos", request: childRequest, result: { ...result, request: childRequest } } }));
  await page.route("**/api/v1/intraday/runs/copied", (route) => route.fulfill({ json: { ...source, id: "copied" } }));
  await page.route("**/api/v1/intraday/runs/oos/clone", (route) => {
    expect(route.request().method()).toBe("POST"); cloneCount++;
    return route.fulfill({ status: 202, json: { ...source, id: "copied" } });
  });
  await page.route("**/api/v1/intraday/chart?**", (route) => route.fulfill({ json: { symbol: "005930", timeframe: "5m", bars: [], revision: "test", gaps: [], totalBars: 0, truncated: false } }));
  await page.route("**/api/v1/intraday/runs/done/validations", (route) => {
    if (route.request().method() === "POST") {
      const config = route.request().postDataJSON() as PeriodValidationConfig;
      expect(config).toEqual({ mode: "HOLDOUT", splitDate: "2026-07-01" });
      const plan = buildPeriodValidationPlan(sourceRequest, config);
      experiment = { id: "validation", sourceJobId: "done", status: "COMPLETED", config, plan, initialCash: 10000000, createdAtMs: at, error: null,
        trials: ["TRAIN", "OOS"].map((role, i) => ({ id: role, role: role as "TRAIN" | "OOS", fold: 0, candidate: 0, parameters: sourceRequest.parameters,
          period: i ? plan.folds[0]!.test : plan.folds[0]!.train, jobId: i ? "oos" : "train", status: "COMPLETED", progress: null, error: null,
          metrics: { totalReturnPct: 1, cagrPct: null, maxDrawdownPct: -1, sharpe: 1.2, tradeCount: 2 }, skipReason: null, selection: null })) };
      return route.fulfill({ status: 201, json: { experiment } });
    }
    return route.fulfill({ json: { experiments: experiment ? [experiment] : [] } });
  });
  await page.route("**/api/v1/intraday/validations/validation", (route) => route.fulfill({ json: { experiment } }));
  await page.route("**/api/v1/intraday/validations/validation/trials/*/daily", (route) => route.fulfill({ json: { report: null } }));
  await page.route("**/api/v1/intraday/runs/oos/lineage", (route) => route.fulfill({ json: { complete: true, kind: "validation", roleLabel: "OOS 검증", items: [
    { label: "백테스트", href: "/backtests/intraday" }, { label: "결과 done", href: "/backtests/intraday/done" },
    { label: "홀드아웃", href: "/backtests/intraday/validations/validation" }, { label: "1회차 · OOS 검증" },
  ] } }));
  await page.goto("/backtests/intraday/done");
  await expect(page.getByRole("link", { name: "설정 탐색 실험 열기" })).toHaveAttribute("href", "/backtests/intraday/done/search");
  await page.getByRole("link", { name: "기간검증 열기" }).click();
  await expect(page).toHaveURL(/\/backtests\/intraday\/done\/validations$/);
  const form = page.getByRole("region", { name: "기간 검증" });
  await form.getByLabel("검증 방식", { exact: true }).click();
  await page.getByRole("option", { name: "워크포워드", exact: true }).click();
  await expect(form.getByLabel("학습 기간 (개월)")).toHaveValue("3");
  await expect(form.getByLabel("평가·이동 기간 (개월)")).toHaveValue("1");
  await expect(form.getByLabel("파라미터 최적화")).not.toBeChecked();
  await expect(form.getByLabel("IS 선택 기준")).toHaveCount(0);
  await expect(form.getByText(/원본 설정으로 IS와 OOS를 독립적으로 실행/)).toBeVisible();
  await form.getByLabel("파라미터 최적화").check();
  await form.getByLabel("IS 선택 기준").click();
  await expect(page.getByRole("option", { name: "CAGR 최대" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await form.getByLabel("검증 방식", { exact: true }).click();
  await page.getByRole("option", { name: "홀드아웃", exact: true }).click();
  await expect(form.getByLabel("파라미터 최적화")).toBeChecked();
  await expect(form.getByLabel("IS 선택 기준")).toBeVisible();
  await form.getByLabel("파라미터 최적화").uncheck();
  await expect(form.getByLabel("IS 선택 기준")).toHaveCount(0);
  await form.getByLabel("OOS 시작일").fill("2026-07-01");
  await form.getByRole("button", { name: "검증 실험 실행" }).click();
  await form.getByRole("link", { name: "상세 보기" }).click();
  await expect(page).toHaveURL(/\/backtests\/intraday\/validations\/validation$/);
  await expect(page.getByLabel("평가할 OOS 구간")).toHaveCount(0);
  await expect(page.getByText("완료", { exact: true })).toHaveCount(0);
  await page.locator('a[href="/backtests/intraday/oos"]').first().click();
  await expect(page.getByRole("navigation", { name: "백테스트 경로" })).toContainText("1회차 · OOS 검증");
  await page.getByRole("button", { name: "그대로 복제", exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/intraday\/copied$/);
  expect(cloneCount).toBe(1);
  await expect(page.getByRole("navigation", { name: "백테스트 경로" })).toContainText("결과 copied");
  await expect(page.getByRole("navigation", { name: "백테스트 경로" })).not.toContainText("OOS 검증");
  expect(wrongApi).toEqual([]);
});

test("지연된 복제 설정이 도착하기 전에는 편집할 수 없다", async ({ page }) => {
  await login(page);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await page.route("**/api/v1/intraday/runs/done", async (route) => {
    entered();
    await pending;
    await route.fulfill({ json: completed });
  });
  try {
    await page.goto("/backtests/intraday/new?clone=done");
    await started;
    await expect(page.getByLabel("장기 EMA", { exact: true })).toHaveCount(0);
    release();
    const field = page.getByLabel("장기 EMA", { exact: true });
    await expect(field).toHaveValue("26");
    await field.fill("30");
    await expect(field).toHaveValue("30");
  } finally {
    release();
  }
});

test("분봉의 다른 전략 페이지 자동 보정은 기존 선택을 유지한다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  const runs = Array.from({ length: 13 }, (_, i) => ({
    ...completed, result: undefined, id: `history-${i}`,
    request: { ...request, strategyId: i === 12 ? "intraday-orb" : "intraday-ema" },
    status: "COMPLETED", createdAtMs: at + i * 60000,
  }));
  let shrink = false;
  await page.route("**/api/v1/intraday/runs/groups", (route) => route.fulfill({ json: {
    groups: [{ strategyId: "intraday-ema", total: shrink ? 10 : 12 }, { strategyId: "intraday-orb", total: 1 }],
  } }));
  await page.route("**/api/v1/intraday/runs?**", (route) => {
    const q = new URL(route.request().url()).searchParams;
    const rows = runs.filter((run) => run.request.strategyId === q.get("strategyId") && (!shrink || !["history-10", "history-11"].includes(run.id)));
    const offset = Number(q.get("offset")), limit = Number(q.get("limit"));
    return route.fulfill({ json: { runs: rows.slice(offset, offset + limit), total: rows.length } });
  });
  await page.goto("/backtests/intraday?view=table&page.intraday-ema=2");
  const group = page.locator("section").filter({ has: page.getByRole("heading", { name: "시초가 범위 돌파", exact: true }) });
  await group.getByRole("button", { name: "편집", exact: true }).click();
  const checkbox = group.getByRole("checkbox", { name: /백테스트 선택$/ });
  await checkbox.check();
  shrink = true;
  await page.clock.runFor(5_100);
  await expect(page).not.toHaveURL(/page\.intraday-ema=2/);
  await expect(checkbox).toBeChecked();
});

const paperRequest = {
  ...request, timeframe: "15m", period: { from: "2024-01-02", to: "2024-12-20" },
  parameters: { ...request.parameters, fast: 2, slow: 3 },
};
const paperSource = { ...completed, request: paperRequest, result: { ...result, request: paperRequest, strategyVersion: "2.0.0" } };

// 생성 응답 유실 뒤 재시도할 때 같은 요청 ID를 사용해야 중복 계좌가 생기지 않는다.
test("완료된 분봉 결과로 모의투자를 만들고 실패 후 같은 요청을 재시도한다", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/intraday/runs/done", (route) => route.fulfill({ json: paperSource }));
  await page.route("**/api/v1/intraday/chart?**", (route) => route.fulfill({ json: { symbol: request.symbol, timeframe: request.timeframe, bars: [], revision: "test", gaps: [], totalBars: 0, truncated: false } }));
  const requests: { sourceRunId: string; requestId: string; title?: string }[] = [];
  await page.route("**/api/v1/trading/intraday-presets", (route) => {
    requests.push(route.request().postDataJSON());
    return requests.length === 1
      ? route.fulfill({ status: 503, json: { error: "응답을 받지 못했습니다." } })
      : route.fulfill({ status: 201, json: { id: "paper-minute", snapshot: { revision: 0, deployment: null, dataPreparation: null, paperCapital: { initialCashKrw: 10000000, canEdit: true }, broker: { provider: "PAPER", configured: true, accounts: [], selectedAccountId: "PAPER", lastSyncAtMs: null, error: null }, account: null, performance: null, positions: [], orders: [], events: [], blockers: [] } } });
  });
  await page.route("**/api/v1/trading", (route) => route.fulfill({ json: {
    revision: 0, deployment: null, dataPreparation: null, paperCapital: { initialCashKrw: 100000000, canEdit: true },
    broker: { provider: "PAPER", configured: true, accounts: [], selectedAccountId: "PAPER", lastSyncAtMs: null, error: null },
    account: null, performance: null, positions: [], orders: [], events: [], blockers: [],
  } }));
  await page.route("**/api/v1/trading/presets", (route) => route.fulfill({ json: { presets: [] } }));
  await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [] } }));
  await page.goto("/backtests/intraday/done");
  await page.getByRole("button", { name: "이 설정으로 매매 준비" }).click();
  await expect(page).toHaveURL(/\/trading\?sourceRunId=done/);
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "매매 설정" }).click();
  const dialog = page.getByRole("dialog", { name: "매매 설정" });
  await expect(dialog).toContainText("005930");
  await expect(dialog).toContainText("확정된 1분 OHLCV");
  await expect(dialog).toContainText("2.0.0");
  await expect(dialog).toContainText("2024-01-02 ~ 2024-12-20");
  await expect(dialog).toContainText("현재 분봉 체결 엔진");
  await dialog.getByLabel("모의투자 이름 (선택)").fill("분봉 실험");
  await dialog.getByRole("button", { name: "설정 저장" }).click();
  await expect(dialog.getByRole("alert")).toContainText("응답을 받지 못했습니다.");
  await page.reload();
  await page.getByRole("button", { name: "새 모의투자" }).click();
  await expect(page.getByLabel("모의투자 이름 (선택)")).toHaveValue("분봉 실험");
  await page.getByRole("dialog", { name: "매매 설정" }).getByRole("button", { name: "설정 저장" }).click();
  await expect(page).toHaveURL(/\/trading\?presetId=paper-minute/);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual({ sourceRunId: "done", requestId: expect.any(String), title: "분봉 실험" });
  expect(requests[1]).toEqual(requests[0]);
});

// 기존 일봉 또는 분봉 계좌가 있어도 새 계좌에는 선택한 분봉 원본을 사용해야 한다.
for (const timeframe of ["1d", "5m"] as const) {
  test(`기존 ${timeframe} 계좌에서 분봉 결과로 새 모의투자를 준비한다`, async ({ page }) => {
    await login(page);
    await page.route("**/api/v1/intraday/runs/done", (route) => route.fulfill({ json: paperSource }));
    const deployment = { id: "existing", name: "기존 전략", strategyId: "intraday-ema", version: "1", status: "INACTIVE", timeframe,
      request: { ...request, symbol: "000660" }, sourceRunId: "existing-run", lastDecisionAtMs: null, lastError: null, activity: "대기" };
    await page.route("**/api/v1/trading", (route) => route.fulfill({ json: {
      revision: 1, deployment, dataPreparation: null, paperCapital: { initialCashKrw: 100000000, canEdit: true },
      broker: { provider: "PAPER", configured: true, accounts: [], selectedAccountId: "PAPER", lastSyncAtMs: null, error: null },
      account: null, performance: null, positions: [], orders: [], events: [], blockers: [],
    } }));
    await page.route("**/api/v1/trading/presets", (route) => route.fulfill({ json: { presets: [] } }));
    await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [] } }));
    await page.goto("/trading?sourceRunId=done");
    await page.getByRole("button", { name: "새 모의투자" }).click();
    const dialog = page.getByRole("dialog", { name: "매매 설정" });
    await expect(dialog).toContainText("005930");
    await expect(dialog).toContainText("고정 체결 조건");
    await expect(dialog).not.toContainText("000660");
  });
}
