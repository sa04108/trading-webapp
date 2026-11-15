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
  await page.route(/\/api\/v1\/backtest-clone-batches(?:\?|$)/, (route) =>
    route.fulfill({ json: { batches: [], sourceJobs: [] } }),
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
  await expect(
    page.getByRole("button", {
      name: testInfo.project.name === "mobile" ? "표 보기" : "카드 보기",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "표 보기", exact: true }).click();
  await expect(group.locator("tbody > tr")).toHaveCount(10);
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
  await page.getByRole("button", { name: "카드 보기", exact: true }).click();
  await expect(group.locator('a[href^="/backtests/history-"]')).toHaveCount(6);
  const boxes = await group
    .locator('a[href^="/backtests/history-"]')
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width };
      }),
    );
  expect(boxes.every((b) => b.width <= 361)).toBe(true);
  if (testInfo.project.name === "desktop")
    expect(boxes[0]!.y).toBe(boxes[1]!.y);
  await page.getByRole("button", { name: "표 보기", exact: true }).click();
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
