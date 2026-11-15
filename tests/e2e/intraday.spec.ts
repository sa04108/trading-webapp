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
  await page.route("**/api/v1/intraday/history/*", (route) => {
    expect(route.request().method()).toBe("DELETE");
    deleted.push(new URL(route.request().url()).pathname.split("/").at(-1)!);
    return route.fulfill({ status: 204 });
  });
  await page.goto("/backtests/intraday?view=table&page.intraday-ema=2&collapsed=intraday-orb");
  const group = page.locator("section").filter({ has: page.getByRole("heading", { name: "EMA 교차", exact: true }) });
  await expect(group.locator("tbody > tr")).toHaveCount(2);
  const edit = page.getByRole("button", { name: "편집", exact: true });
  const view = page.getByRole("switch", { name: "카드 보기" });
  const editBox = await edit.boundingBox(), viewBox = await view.boundingBox();
  if (!editBox || !viewBox) throw new Error("이력 도구를 찾을 수 없습니다");
  expect(editBox.x + editBox.width).toBeLessThan(viewBox.x);
  await edit.click();
  await expect(edit).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "현재 페이지 전체 삭제", exact: true }).click();
  await expect.poll(() => [...deleted].sort()).toEqual(["history-10", "history-11"]);
  await expect(group.locator("tbody > tr")).toHaveCount(10);
  await expect(edit).toHaveAttribute("aria-pressed", "false");
  await edit.click();
  await expect(group.getByRole("row").filter({ hasText: "진행 중" }).getByRole("checkbox")).toBeDisabled();
  await page.getByRole("checkbox", { name: "현재 페이지 선택", exact: true }).check();
  await expect(page.getByRole("button", { name: "현재 페이지 선택 삭제 (9)", exact: true })).toBeEnabled();
  await view.click();
  await expect(view).toBeChecked();
  await expect(page.getByRole("button", { name: "현재 페이지 선택 삭제 (0)", exact: true })).toBeDisabled();
  await expect(group.getByRole("checkbox")).toHaveCount(6);
  await expect(group.getByRole("checkbox").first()).toBeDisabled();
});
