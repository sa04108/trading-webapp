import { expect, test, type Page } from "@playwright/test";
import { login } from "./login";

function strategyGroup(page: Page, name = "전략 A") {
  return page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

async function historyFixture(page: Page) {
  const jobs = Array.from({ length: 13 }, (_, i) => ({
    id: `history-${i}`,
    status: i === 11 ? "FAILED" : "COMPLETED",
    strategyId: i === 12 ? "strategy-b" : "strategy-a",
    request: {
      strategyId: i === 12 ? "strategy-b" : "strategy-a",
      parameters: {},
      universeRule: {
        markets: ["KOSPI"],
        stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 100 }],
        rebalanceInterval: { value: 1, unit: "MONTH" },
      },
      period: {
        from: `2025-${String((i % 12) + 1).padStart(2, "0")}-01`,
        to: "2026-01-01",
      },
      capital: { initialCash: 10000000, currency: "KRW" },
      execution: {
        fillTiming: "NEXT_BAR_OPEN",
        commissionProfileId: "kr-equity-default",
        slippageProfileId: "fixed-5bps",
      },
      risk: { maxPositions: 5 },
      randomSeed: 42,
    },
    progressBars: null,
    totalBars: null,
    progressLabel: null,
    error: i === 11 ? `예시 실행 오류: ${"COLLECTION_FAILED_".repeat(20)}` : null,
    createdAtMs: Date.UTC(2026, 10, 15 - i),
    startedAtMs: null,
    completedAtMs: Date.UTC(2026, 10, 15 - i),
    cloneBatchId: null,
    cloneSourceJobId: null,
    metrics:
      i === 11
        ? null
        : {
            totalReturnPct: i === 12 ? 12345.67 : i === 10 ? 99 : i,
            cagrPct: i,
            maxDrawdownPct: -5,
            tradeCount: 1,
          },
  }));
  const deleted: string[] = [];
  const requests: URLSearchParams[] = [];
  await page.route("**/api/v1/backtests/deletion-preview", (route) => {
    const { ids } = route.request().postDataJSON() as { ids: string[] };
    return route.fulfill({ json: { backtestCount: ids.length, configurationSearchCount: 0, periodValidationCount: 3, blockers: [], token: "preview" } });
  });
  await page.route("**/api/v1/backtests/delete", (route) => {
    const { ids, mode, token } = route.request().postDataJSON() as { ids: string[]; mode: string; token: string };
    expect(mode).toBe("daily"); expect(token).toBe("preview"); deleted.push(...ids);
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/v1/strategies", (route) =>
    route.fulfill({
      json: {
        strategies: [
          { id: "strategy-a", name: "전략 A", version: "1", description: "" },
          { id: "strategy-b", name: "전략 B", version: "1", description: "" },
        ],
      },
    }),
  );
  await page.route("**/api/v1/backtests/groups", (route) =>
    route.fulfill({
      json: {
        groups: ["strategy-a", "strategy-b"]
          .map((strategyId) => ({
            strategyId,
            total: jobs.filter(
              (j) => j.strategyId === strategyId && !deleted.includes(j.id),
            ).length,
          }))
          .filter((g) => g.total),
      },
    }),
  );
  await page.route(/\/api\/v1\/backtests(?:\?|$)/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query);
    let records = jobs.filter(
      (j) =>
        (!query.get("strategyId") ||
          j.strategyId === query.get("strategyId")) &&
        !deleted.includes(j.id),
    );
    // 응답 순서는 서버 통합 검사에서 검증하므로 여기서는 선택한 조회 조건의 전달만 재현한다.
    if (query.get("sort") === "returnPct")
      records = records
        .filter((j) => j.id === "history-10")
        .concat(records.filter((j) => j.id !== "history-10"));
    const offset = Number(query.get("offset") ?? 0),
      limit = Number(query.get("limit") ?? 50);
    return route.fulfill({
      json: {
        jobs: records.slice(offset, offset + limit),
        total: records.length,
      },
    });
  });
  await page.route(/\/api\/v1\/backtests\/history-extras(?:\?|$)/, (route) =>
    route.fulfill({ json: { summaries: new URL(route.request().url()).searchParams.get("jobIds")?.split(",").map((jobId) => ({ jobId, benchmarkExcessReturnPct: null, seed: { batchCount: ["history-0", "history-1"].includes(jobId) ? 1 : 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null } }, validation: { experimentCount: ["history-0", "history-2"].includes(jobId) ? 1 : 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null }, modes: {} } })) ?? [] } }),
  );
  await page.route(/\/api\/v1\/backtests\/history-\d+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "DELETE") {
      deleted.push(id);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: {
        job: jobs.find((j) => j.id === id),
        run: null,
        metrics: null,
        benchmark: null,
        provenancePin: null,
        universeRebalancing: [],
      },
    });
  });
  return { jobs, requests, deleted };
}

// 기존 건수·보기 검사는 전략마다 별도 표의 열 경계가 달라지는 회귀를 잡지 못한다.
async function expectAlignedHistoryColumns(page: Page) {
  await expect.poll(() => page.getByRole("table").evaluateAll((tables) => {
    const columns = Array.from(tables[0]!.querySelectorAll("th"), (cell) => cell.getBoundingClientRect());
    return Math.max(0, ...tables.flatMap((table) => Array.from(table.querySelectorAll("tr"), (row) =>
      Array.from(row.children, (cell, index) => {
        const bounds = cell.getBoundingClientRect(), header = columns[index]!;
        return Math.max(Math.abs(bounds.left - header.left), Math.abs(bounds.right - header.right));
      }),
    ).flat()));
  })).toBeLessThanOrEqual(1);
}

// 기존 목록 검사는 첫 화면만 확인한다. 실제 조작으로 페이지·뒤로가기·삭제 범위가 유지되는지 검증한다.
test("전략별 전체 이력에서 정렬·보기·페이지를 전환하고 뒤로 돌아온다", async ({
  page,
}, testInfo) => {
  await login(page);
  const { requests } = await historyFixture(page);
  await page.goto("/backtests");
  const group = page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: /전략 A/ }) });
  const other = page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: /전략 B/ }) });
  await expect(group).toContainText("12건");
  const viewToggle = page.getByRole("switch", { name: "카드 보기" });
  await expect(viewToggle).toHaveCount(1);
  await expect(viewToggle).toBeChecked({ checked: testInfo.project.name === "desktop" });
  await expect(viewToggle).toHaveText("");
  if (testInfo.project.name === "desktop") await viewToggle.click();
  await expect(viewToggle).not.toBeChecked();
  const edit = strategyGroup(page).getByRole("button", { name: "편집", exact: true });
  const editBox = await edit.boundingBox();
  const moreBox = await group.getByRole("button", { name: "전략 A 접기", exact: true }).boundingBox();
  if (!editBox || !moreBox) throw new Error("전략별 편집 도구를 찾을 수 없습니다");
  await expect(edit).toHaveText("편집");
  expect(editBox.x + editBox.width).toBeLessThan(moreBox.x);
  expect(Math.abs(editBox.y + editBox.height / 2 - moreBox.y - moreBox.height / 2)).toBeLessThanOrEqual(1);
  await expect(group.locator("tbody > tr")).toHaveCount(10);
  const firstRow = group.locator("tbody > tr").first();
  await expect(firstRow.getByRole("link", { name: "난수", exact: true })).toHaveAttribute("href", "/backtests/history-0/seeds");
  await expect(firstRow.getByRole("link", { name: "검증", exact: true })).toHaveAttribute("href", "/backtests/history-0/validations");
  // 건수가 0인데도 양쪽 버튼을 항상 표시하던 회귀를 표·카드에서 함께 확인한다.
  const experimentLinks = group.locator('a[href$="/seeds"], a[href$="/validations"]');
  const expectedExperimentLinks = ["/backtests/history-0/seeds", "/backtests/history-0/validations", "/backtests/history-1/seeds", "/backtests/history-2/validations"];
  await expect.poll(() => experimentLinks.evaluateAll((links) => links.map((link) => link.getAttribute("href")).sort())).toEqual(expectedExperimentLinks);
  await expect(group.getByRole("columnheader")).toHaveText(["기간", "수익률", "CAGR", "MDD", "실행일"]);

  await expect(other.locator("tbody > tr")).toHaveCount(1);
  await expectAlignedHistoryColumns(page);
  await group.getByRole("button", { name: "다음", exact: true }).click();
  await expect(group.locator("tbody > tr")).toHaveCount(2);
  await expect(other.locator("tbody > tr")).toHaveCount(1);
  await expectAlignedHistoryColumns(page);
  // 공백 없는 오류 코드도 기간 열을 화면 밖으로 밀어내지 않아야 한다.
  await expect.poll(async () => (await group.getByRole("columnheader", { name: "기간", exact: true }).boundingBox())!.width)
    .toBeLessThan(page.viewportSize()!.width);
  await group.locator('a[href="/backtests/history-11"]').click();
  await expect(page).toHaveURL(/\/backtests\/history-11$/);
  await page.goBack();
  await expect(group.locator("tbody > tr")).toHaveCount(2);
  await expect(page).toHaveURL(/page.strategy-a=2/);
  await page.getByRole("combobox", { name: "전략 내 기록 정렬" }).click();
  await page
    .getByRole("option", { name: "수익률 · 높은 순", exact: true })
    .click();
  await expect(group.locator("tbody > tr").first()).toContainText("+99.00%");
  expect(
    requests.some(
      (q) =>
        q.get("sort") === "returnPct" &&
        q.get("offset") === "0" &&
        q.get("strategyId") === "strategy-a",
    ),
  ).toBe(true);
  await viewToggle.click();
  await expect(viewToggle).toBeChecked();
  await expect(group.locator('a[href^="/backtests/history-"]:not([href$="/seeds"]):not([href$="/validations"])')).toHaveCount(6);
  await expect.poll(() => experimentLinks.evaluateAll((links) => links.map((link) => link.getAttribute("href")).sort())).toEqual(expectedExperimentLinks);
  const boxes = await group
    .locator('a[href^="/backtests/history-"]:not([href$="/seeds"]):not([href$="/validations"])')
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        // 실험 버튼이 있는 카드와 없는 카드는 제목 높이가 다르므로 카드 자체를 비교한다.
        const r = n.closest('[data-slot="card"]')!.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width };
      }),
    );
  expect(boxes.every((b) => b.width <= 361)).toBe(true);
  if (testInfo.project.name === "desktop")
    expect(boxes[0]!.y).toBe(boxes[1]!.y);
  await expect(viewToggle).toBeChecked();
  await viewToggle.focus();
  await page.keyboard.press("Space");
  await expect(viewToggle).not.toBeChecked();
  if (testInfo.project.name === "mobile")
    await page.setViewportSize({ width: 320, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("history.png"),
    fullPage: true,
  });
  if (testInfo.project.name === "desktop") {
    const period = group.getByRole("columnheader", { name: "기간", exact: true });
    const before = await period.boundingBox();
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect.poll(async () => (await period.boundingBox())!.width).toBeLessThan(before!.width);
    await expectAlignedHistoryColumns(page);
  } else {
    const history = page.getByRole("region", { name: "백테스트 이력", exact: true });
    await history.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => history.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await expectAlignedHistoryColumns(page);
  }
});

test("삭제는 펼친 전략의 현재 페이지에 한정하고 빈 마지막 페이지를 보정한다", async ({
  page,
}) => {
  await login(page);
  const { deleted } = await historyFixture(page);
  await page.goto(
    "/backtests?view=table&page.strategy-a=2&collapsed=strategy-b",
  );
  const group = page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: /전략 A/ }) });
  await expect(group.locator("tbody > tr")).toHaveCount(2);
  await strategyGroup(page).getByRole("button", { name: "편집", exact: true }).click();
  await group.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await group.getByRole("button", { name: "삭제 (2)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("기간검증 3개");
  await expect(dialog).not.toContainText("설정 탐색 실험");
  await dialog.getByRole("button", { name: "취소" }).click();
  expect(deleted).toEqual([]);
  await group.getByRole("button", { name: "삭제 (2)", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "삭제", exact: true }).click();
  await expect.poll(() => deleted.length).toBe(2);
  expect([...deleted].sort()).toEqual(["history-10", "history-11"]);
  await expect(group.locator("tbody > tr")).toHaveCount(10);
  await expect(
    group.getByRole("button", { name: "다음", exact: true }),
  ).toBeDisabled();
});

// 기존 목록 검사는 사용자 열 선택·드래그 저장과 일봉/분봉 전환 후 복원을 다루지 않는다.
test("표시 항목과 순서를 저장하고 일봉·분봉에 같은 표 구성을 적용한다", async ({ page }, testInfo) => {
  await login(page);
  await historyFixture(page);
  const strategies = ["intraday-ema", "intraday-orb"];
  await page.route("**/api/v1/intraday/runs/groups", (route) => route.fulfill({ json: { groups: strategies.map((strategyId) => ({ strategyId, total: 1 })) } }));
  await page.route("**/api/v1/intraday/runs?**", (route) => {
    const strategyId = new URL(route.request().url()).searchParams.get("strategyId");
    return route.fulfill({ json: {
      total: 1, runs: [{ id: `columns-${strategyId}`, status: "COMPLETED", error: null, createdAtMs: Date.UTC(2026, 10, 15),
        request: { strategyId, symbol: "005930", timeframe: "5m", period: { from: "2026-01-01", to: "2026-02-01" } },
        metrics: { returnPct: strategyId === "intraday-ema" ? 5 : 12345.67, maxDrawdownPct: -3, sharpe: 1.25 },
      }],
    } });
  });
  const mobile = testInfo.project.name === "mobile";
  if (mobile) await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/backtests?view=table");
  const table = page.getByRole("table").first();
  await expect(table.getByRole("columnheader")).toHaveText(["기간", "수익률", "CAGR", "MDD", "실행일"]);
  await page.getByRole("button", { name: "표시 항목", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "표시 항목", exact: true });
  await expect(menu.getByRole("checkbox")).toHaveCount(7);
  await expect(menu).not.toContainText("기본 항목");
  await expect(menu).not.toContainText("추가 항목");
  await menu.getByRole("checkbox", { name: "CAGR 표시", exact: true }).uncheck();
  const source = menu.getByRole("button", { name: "실행일 순서 변경", exact: true });
  const first = menu.getByRole("button", { name: "수익률 순서 변경", exact: true });
  const start = await source.boundingBox(), end = await first.boundingBox();
  if (!start || !end) throw new Error("열 순서 손잡이를 찾지 못했습니다");
  const x = start.x + start.width / 2, y = start.y + start.height / 2, targetY = end.y + end.height / 2;
  if (mobile) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 12; step++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (targetY - y) * step / 12, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, targetY, { steps: 12 });
    await page.mouse.up();
  }
  await expect(table.getByRole("columnheader")).toHaveText(["기간", "실행일", "수익률", "MDD"]);
  await expect(menu.getByRole("checkbox", { name: "CAGR 표시", exact: true })).not.toBeChecked();
  await menu.getByRole("checkbox", { name: "난수 표시", exact: true }).check();
  await menu.getByRole("checkbox", { name: "검증 표시", exact: true }).check();
  await menu.getByRole("checkbox", { name: "Sharpe 표시", exact: true }).check();
  const sharpe = menu.getByRole("button", { name: "Sharpe 순서 변경", exact: true });
  await sharpe.focus();
  await page.keyboard.press("Space");
  await expect(sharpe).toHaveAttribute("aria-pressed", "true");
  const announcement = page.getByRole("status").filter({ hasText: "Sharpe" });
  await expect(announcement).toHaveText("Sharpe, 5번째 위치입니다.");
  await page.keyboard.press("ArrowUp");
  await expect(announcement).toHaveText("Sharpe, 4번째 위치입니다.");
  await page.keyboard.press("Space");
  const headers = ["기간", "실행일", "수익률", "Sharpe", "MDD", /난수/, /검증/];
  await expect(table.getByRole("columnheader")).toHaveText(headers);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const menuBox = await menu.boundingBox();
  const triggerBox = await page.getByRole("button", { name: "표시 항목", exact: true }).boundingBox();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(menuBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);
  await page.screenshot({ path: testInfo.outputPath("column-picker.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(table.getByRole("columnheader")).toHaveText(headers);
  await expectAlignedHistoryColumns(page);
  await page.goto("/backtests/intraday?view=table");
  await expect(table.getByRole("columnheader")).toHaveText(headers);
  await expect(page.getByRole("table")).toHaveCount(2);
  await expectAlignedHistoryColumns(page);
  await expect(table.locator("tbody tr").first().getByRole("cell").nth(3)).toHaveText("1.25");
  await expect(table.locator("tbody tr").first().getByRole("cell").nth(5)).toHaveText("—");
  await page.getByRole("button", { name: "표시 항목", exact: true }).click();
  await expect(menu.getByRole("checkbox", { name: "CAGR 표시", exact: true })).not.toBeChecked();
  await menu.getByRole("checkbox", { name: "CAGR 표시", exact: true }).check();
  await page.keyboard.press("Escape");
  await page.goto("/backtests?view=table");
  await expect(table.getByRole("columnheader")).toHaveText(["기간", "실행일", "수익률", "CAGR", "Sharpe", "MDD", /난수/, /검증/]);
});

// 기존 정적 렌더링·삭제 검사는 5초 재조회 중 체크박스가 사라지는 회귀를 잡지 못한다.
for (const view of ["table", "cards"] as const) {
  test(`${view} 편집에서 백그라운드 갱신 중 체크박스·선택·배치를 유지한다`, async ({ page }) => {
    await login(page);
    await historyFixture(page);
    await page.clock.install();
    let holdResponse = false;
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    await page.route(/\/api\/v1\/backtests\/history-extras(?:\?|$)/, async (route) => {
      if (holdResponse) {
        entered();
        await pending;
      }
      await route.fulfill({ json: { summaries: new URL(route.request().url()).searchParams.get("jobIds")?.split(",").map((jobId) => ({ jobId, benchmarkExcessReturnPct: null, seed: { batchCount: 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null } }, validation: { experimentCount: 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null }, modes: {} } })) ?? [] } });
    });
    await page.goto(`/backtests?view=${view}&collapsed=strategy-b`);
    await strategyGroup(page).getByRole("button", { name: "편집", exact: true }).click();
    const checkboxes = page.getByRole("checkbox", { name: /백테스트 선택$/ });
    const count = view === "table" ? 10 : 6;
    await expect(checkboxes).toHaveCount(count);
    const checkbox = checkboxes.first();
    await checkbox.check();
    await checkbox.focus();
    const element = await checkbox.elementHandle();
    const before = await checkbox.boundingBox();
    const remove = page.getByRole("button", { name: "삭제 (1)", exact: true });
    await expect(remove).toBeEnabled();
    holdResponse = true;
    try {
      await page.clock.runFor(5_100);
      await started;
      await page.clock.runFor(50);
      expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
      await expect(checkboxes).toHaveCount(count);
      await expect(checkbox).toBeChecked();
      await expect(checkbox).toBeFocused();
      await expect(remove).toBeEnabled();
      expect(await checkbox.boundingBox()).toEqual(before);
      const response = page.waitForResponse(/\/api\/v1\/backtests\/history-extras(?:\?|$)/);
      release();
      await response;
      await page.clock.runFor(50);
      await expect(checkbox).toBeChecked();
      await expect(checkbox).toBeFocused();
      expect(await checkbox.boundingBox()).toEqual(before);
    } finally {
      release();
    }
  });
}

test("실험 정보 재조회 실패에도 선택과 삭제 확인을 허용한다", async ({ page }) => {
  await login(page);
  await historyFixture(page);
  await page.clock.install();
  let fail = false;
  await page.route(/\/api\/v1\/backtests\/history-extras(?:\?|$)/, (route) => {
    if (fail) return route.fulfill({ status: 503, json: { error: "unavailable" } });
    const ids = new URL(route.request().url()).searchParams.get("jobIds")?.split(",") ?? [];
    return route.fulfill({ json: { summaries: ids.map((jobId) => ({ jobId, benchmarkExcessReturnPct: null, seed: { batchCount: 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null } }, validation: { experimentCount: 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null }, modes: {} } })) } });
  });
  await page.goto("/backtests?view=table&collapsed=strategy-b");
  await strategyGroup(page).getByRole("button", { name: "편집", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: /백테스트 선택$/ }).first();
  await checkbox.check();
  await expect(page.getByRole("checkbox", { name: "전체 선택" })).toHaveAttribute("data-state", "indeterminate");
  fail = true;
  await page.clock.runFor(10_000);
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeEnabled();
  await expect(page.getByRole("button", { name: "삭제 (1)" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "현재 페이지 전체 삭제" })).toHaveCount(0);
});

test("삭제 미리보기 실패와 변경은 확인을 다시 요구한다", async ({ page }) => {
  await login(page);
  const { deleted } = await historyFixture(page);
  let previewAttempt = 0;
  let deleteAttempt = 0;
  await page.route("**/api/v1/backtests/deletion-preview", (route) => {
    previewAttempt++;
    if (previewAttempt === 1) return route.fulfill({ status: 503, json: { error: "unavailable" } });
    return route.fulfill({ json: { backtestCount: 1, configurationSearchCount: 0, periodValidationCount: 3, blockers: [], token: `token-${previewAttempt}` } });
  });
  await page.route("**/api/v1/backtests/delete", (route) => {
    deleteAttempt++;
    if (deleteAttempt === 1) return route.fulfill({ status: 409, json: { error: "changed" } });
    const body = route.request().postDataJSON() as { ids: string[]; token: string };
    expect(body.token).toBe("token-3");
    deleted.push(...body.ids);
    return route.fulfill({ status: 204 });
  });
  await page.goto("/backtests?view=table&collapsed=strategy-b");
  const group = strategyGroup(page);
  await group.getByRole("button", { name: "편집", exact: true }).click();
  await group.getByRole("checkbox", { name: /백테스트 선택$/ }).first().check();
  await group.getByRole("button", { name: "삭제 (1)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("삭제 범위를 불러오지 못했습니다");
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "다시 시도" }).click();
  await expect(dialog).toContainText("기간검증 3개");
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(dialog).toContainText("삭제 범위가 변경되었습니다");
  await expect.poll(() => previewAttempt).toBe(3);
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeEnabled();
  expect(deleted).toEqual([]);
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect.poll(() => deleted.length).toBe(1);
});

test("다른 전략의 페이지 자동 보정은 기존 선택을 유지한다", async ({ page }) => {
  await login(page);
  const { deleted } = await historyFixture(page);
  await page.clock.install();
  await page.goto("/backtests?view=table&page.strategy-a=2");
  const group = strategyGroup(page, "전략 B");
  await group.getByRole("button", { name: "편집", exact: true }).click();
  const checkbox = group.getByRole("checkbox", { name: /백테스트 선택$/ });
  await checkbox.check();
  deleted.push("history-10", "history-11");
  await page.clock.runFor(5_100);
  await expect(page).not.toHaveURL(/page\.strategy-a=2/);
  await expect(checkbox).toBeChecked();
});

test("새 목록의 실험 정보를 기다리거나 실패해도 기존 선택을 표시한다", async ({ page }) => {
  await login(page);
  const { deleted } = await historyFixture(page);
  await page.clock.install();
  let hold = false;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/v1\/backtests\/history-extras(?:\?|$)/, async (route) => {
    if (hold) {
      entered();
      await pending;
      return route.fulfill({ status: 503, json: { error: "unavailable" } });
    }
    const ids = new URL(route.request().url()).searchParams.get("jobIds")?.split(",") ?? [];
    return route.fulfill({ json: { summaries: ids.map((jobId) => ({ jobId, benchmarkExcessReturnPct: null, seed: { batchCount: 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null } }, validation: { experimentCount: 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null }, modes: {} } })) } });
  });
  await page.goto("/backtests?view=table&collapsed=strategy-b");
  await strategyGroup(page).getByRole("button", { name: "편집", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: /백테스트 선택$/ }).first();
  await checkbox.check();
  hold = true;
  deleted.push("history-9");
  try {
    await page.clock.runFor(5_100);
    await started;
    await expect(checkbox).toBeChecked();
    await expect(page.getByRole("button", { name: "삭제 (1)" })).toBeEnabled();
    release();
    await page.clock.runFor(5_000);
    await expect(checkbox).toBeChecked();
    await checkbox.click();
    await expect(page.getByRole("button", { name: "삭제 (0)" })).toBeDisabled();
  } finally {
    release();
  }
});

// 기존 삭제 검사는 한 전략만 편집해 다른 전략의 선택·페이지까지 삭제에 섞이는 오류를 잡지 못한다.
for (const view of ["table", "cards"] as const) {
  test(`${view} 전략별 편집 도구로 선택과 삭제 범위를 분리한다`, async ({ page }) => {
    await login(page);
    const { deleted } = await historyFixture(page);
    await page.goto(`/backtests?view=${view}`);
    const first = strategyGroup(page), second = strategyGroup(page, "전략 B");
    await expect(page.getByRole("button", { name: "편집", exact: true })).toHaveCount(2);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await first.getByRole("button", { name: "편집", exact: true }).click();
    await expect(second.getByRole("checkbox")).toHaveCount(0);
    await second.getByRole("button", { name: "편집", exact: true }).click();
    const otherSelection = second.getByRole("checkbox", { name: /백테스트 선택$/ });
    await otherSelection.check();
    await first.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
    const selectedCount = view === "table" ? 10 : 6;
    await expect(first.getByRole("button", { name: `삭제 (${selectedCount})`, exact: true })).toBeEnabled();
    await expect(second.getByRole("button", { name: "삭제 (1)", exact: true })).toBeEnabled();
    const tools = [first.getByRole("checkbox", { name: "전체 선택", exact: true }), first.getByRole("button", { name: `삭제 (${selectedCount})`, exact: true }), first.getByRole("button", { name: "완료", exact: true }), first.getByRole("button", { name: "전략 A 접기", exact: true })];
    const boxes = await Promise.all(tools.map(tool => tool.boundingBox()));
    for (let i = 1; i < boxes.length; i++) {
      const before = boxes[i - 1]!, after = boxes[i]!;
      expect(before.x + before.width).toBeLessThanOrEqual(after.x);
      expect(Math.abs(before.y + before.height / 2 - after.y - after.height / 2)).toBeLessThanOrEqual(1);
    }
    await expect(page.getByRole("checkbox", { name: "현재 페이지 선택", exact: true })).toHaveCount(0);
    // 전략 A의 페이지 전환과 편집 종료가 전략 B의 선택을 초기화하지 않는다.
    await first.getByRole("button", { name: "다음", exact: true }).click();
    await expect(first.getByRole("button", { name: "삭제 (0)", exact: true })).toBeDisabled();
    await expect(otherSelection).toBeChecked();
    await first.getByRole("button", { name: "완료", exact: true }).click();
    await expect(first.getByRole("checkbox")).toHaveCount(0);
    await expect(otherSelection).toBeChecked();
    await first.getByRole("button", { name: "편집", exact: true }).click();
    await first.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
    const lastCount = view === "table" ? 2 : 6;
    await first.getByRole("button", { name: `삭제 (${lastCount})`, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "삭제", exact: true }).click();
    await expect.poll(() => [...deleted].sort()).toEqual(view === "table" ? ["history-10", "history-11"] : ["history-10", "history-11", "history-6", "history-7", "history-8", "history-9"]);
    await expect(first.getByRole("button", { name: "편집", exact: true })).toBeVisible();
    await expect(otherSelection).toBeChecked();
    await expect(second.getByRole("button", { name: "삭제 (1)", exact: true })).toBeEnabled();
  });
}
