import { expect, test, type Page } from "@playwright/test";
import { login } from "./login";

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
    error: i === 11 ? "예시 실행 오류" : null,
    createdAtMs: Date.UTC(2026, 10, 15 - i),
    startedAtMs: null,
    completedAtMs: Date.UTC(2026, 10, 15 - i),
    cloneBatchId: null,
    cloneSourceJobId: null,
    metrics:
      i === 11
        ? null
        : {
            totalReturnPct: i === 10 ? 99 : i,
            cagrPct: i,
            maxDrawdownPct: -5,
            tradeCount: 1,
          },
  }));
  const deleted: string[] = [];
  const requests: URLSearchParams[] = [];
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
    route.fulfill({ json: { summaries: new URL(route.request().url()).searchParams.get("jobIds")?.split(",").map((jobId) => ({ jobId, benchmarkExcessReturnPct: null, seed: { batchCount: 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null } }, validation: { experimentCount: 0, activeCount: 0, completedCount: 0, returns: { count: 0, mean: null, sampleStdDev: null }, modes: {} } })) ?? [] } }),
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
  const edit = page.getByRole("button", { name: "편집", exact: true });
  const editBox = await edit.boundingBox();
  const viewBox = await viewToggle.boundingBox();
  if (!editBox || !viewBox) throw new Error("이력 도구를 찾을 수 없습니다");
  expect(editBox.x + editBox.width).toBeLessThan(viewBox.x);
  expect(Math.abs(editBox.y + editBox.height / 2 - viewBox.y - viewBox.height / 2)).toBeLessThanOrEqual(1);
  await expect(group.locator("tbody > tr")).toHaveCount(10);
  const firstRow = group.locator("tbody > tr").first();
  await expect(firstRow.getByRole("link", { name: "난수", exact: true })).toHaveAttribute("href", "/backtests/history-0/seeds");
  await expect(firstRow.getByRole("link", { name: "검증", exact: true })).toHaveAttribute("href", "/backtests/history-0/validations");
  if (testInfo.project.name === "mobile") {
    await expect(group.getByRole("columnheader", { name: /난수/ })).toBeHidden();
  } else {
    await expect(group.getByRole("columnheader", { name: /난수/ })).toBeVisible();
    await expect(group.getByRole("columnheader", { name: /검증/ })).toBeVisible();
  }

  await expect(other.locator("tbody > tr")).toHaveCount(1);
  await group.getByRole("button", { name: "다음", exact: true }).click();
  await expect(group.locator("tbody > tr")).toHaveCount(2);
  await expect(other.locator("tbody > tr")).toHaveCount(1);
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
  const boxes = await group
    .locator('a[href^="/backtests/history-"]:not([href$="/seeds"]):not([href$="/validations"])')
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
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
  await page.getByRole("button", { name: "편집", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "현재 페이지 전체 삭제", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "현재 페이지 전체 삭제", exact: true })
    .click();
  await expect.poll(() => deleted.length).toBe(2);
  expect([...deleted].sort()).toEqual(["history-10", "history-11"]);
  await expect(group.locator("tbody > tr")).toHaveCount(10);
  await expect(
    group.getByRole("button", { name: "다음", exact: true }),
  ).toBeDisabled();
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
    await page.getByRole("button", { name: "편집", exact: true }).click();
    const checkboxes = page.getByRole("checkbox", { name: /백테스트 선택$/ });
    const count = view === "table" ? 10 : 6;
    await expect(checkboxes).toHaveCount(count);
    const checkbox = checkboxes.first();
    await checkbox.check();
    await checkbox.focus();
    const element = await checkbox.elementHandle();
    const before = await checkbox.boundingBox();
    const remove = page.getByRole("button", { name: "현재 페이지 선택 삭제 (1)", exact: true });
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
