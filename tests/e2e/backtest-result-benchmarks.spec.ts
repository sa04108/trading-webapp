import { expect, test } from "@playwright/test";
import { login } from "./login";

const id = "comparison-result";
const request = {
  strategyId: "cross-sectional-momentum", parameters: {},
  universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 10 }], rebalanceInterval: { unit: "MONTH", value: 1 } },
  period: { from: "2023-01-01", to: "2024-01-01" }, capital: { initialCash: 10000000, currency: "KRW" },
  execution: { fillTiming: "NEXT_BAR_OPEN", commissionProfileId: "kr-equity-default", slippageProfileId: "fixed-5bps" }, risk: { maxPositions: 5 }, randomSeed: 42,
  benchmarkId: "KOSPI",
};
const metrics = { initialCash: 10000000, finalEquity: 11000000, totalReturnPct: 10, cagrPct: 3, maxDrawdownPct: -5, sharpe: 1, tradeCount: 12, winRate: 50, totalCommission: 100, totalTax: 100, totalSlippage: 100 };
const first = Date.parse("2023-01-02T00:00:00Z"), last = Date.parse("2023-12-29T00:00:00Z");

// 결과 UI가 과거 pin을 선택으로 복원하거나 비교 실패 때문에 원래 결과를 숨기는 회귀를 잡는다.
test("완료 결과에서 여러 지수 선택을 저장하고 비교 실패를 격리한다", async ({ page }) => {
  await login(page);
  let selected: string[] = [];
  let failLoad = true;
  let failNextRefresh = false;
  let failedRefresh = false;
  let failSave = false;
  let attempts = 0;
  const backfill = { benchmarkId: null, state: "IDLE", from: null, to: null, cursorDate: null, error: null };
  await page.route(`**/api/v1/backtests/${id}`, (route) => route.fulfill({ json: {
    job: { id, status: "COMPLETED", request, strategyId: request.strategyId, createdAtMs: first, completedAtMs: last, cloneBatchId: null, cloneSourceJobId: null, error: null },
    run: null, metrics, benchmark: { name: "과거 벤치마크", available: true, totalReturnPct: 99, excessReturnPct: -89 }, provenancePin: null, universeRebalancing: [],
  } }));
  await page.route(`**/api/v1/backtests/${id}/series`, (route) => route.fulfill({ json: { equity: [{ tsMs: first, value: 10000000 }, { tsMs: last, value: 11000000 }], benchmark: [{ tsMs: first, value: 100 }], drawdown: [], monthly: [], symbols: [], totalEquityPoints: 2 } }));
  await page.route(`**/api/v1/backtests/${id}/trades?**`, (route) => route.fulfill({ json: { trades: [], total: 0 } }));
  await page.route(`**/api/v1/backtests/${id}/benchmarks`, (route) => {
    if (route.request().method() === "PATCH") {
      if (failSave) {
        failSave = false;
        return route.fulfill({ status: 503, json: { error: "선택 저장 실패" } });
      }
      selected = route.request().postDataJSON().benchmarkIds;
      if (!failedRefresh && selected.length === 1 && selected[0] === "KOSPI") failNextRefresh = true;
      return route.fulfill({ json: { benchmarkIds: selected } });
    }
    if (failLoad || failNextRefresh) {
      if (failNextRefresh) { failNextRefresh = false; failedRefresh = true; }
      return route.fulfill({ status: 503, json: { error: "비교 조회 실패" } });
    }
    return route.fulfill({ json: { benchmarkIds: selected, backfill, comparisons: selected.map((benchmarkId) => benchmarkId === "KOSPI" ? {
      benchmarkId, name: "코스피", available: true, unavailableReason: null, totalReturnPct: 4, maxDrawdownPct: -3, excessReturnPct: 6, points: [{ tsMs: first, value: 0 }, { tsMs: last, value: 4 }],
    } : { benchmarkId, name: "S&P 500", available: false, unavailableReason: "기간 데이터가 없습니다", totalReturnPct: null, maxDrawdownPct: null, excessReturnPct: null, points: [] }) } });
  });
  await page.route("**/api/v1/benchmarks/backfill", (route) => {
    attempts++;
    expect(route.request().postDataJSON()).toEqual({ benchmarkId: "SP500", from: request.period.from, to: request.period.to });
    return route.fulfill(attempts === 1 ? { status: 503, json: { error: "수집 실패" } } : { json: { ...backfill, state: "RUNNING", benchmarkId: "SP500" } });
  });
  await page.goto(`/backtests/${id}`);
  await expect(page.getByText("누적 수익률", { exact: true })).toBeVisible();
  await expect(page.getByText("Sharpe", { exact: true }).locator("..").locator("p").nth(1)).toHaveClass(/text-gain/);
  await expect(page.getByText("비교 조회 실패")).toBeVisible();
  await expect(page.getByText("과거 벤치마크")).toHaveCount(0);
  failLoad = false;
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("checkbox", { name: "코스피", exact: true })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "코스피", exact: true }).check();
  await expect(page.getByText("비교 조회 실패")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "코스피", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "S&P 500", exact: true }).check();
  await expect.poll(() => selected).toEqual(["KOSPI", "SP500"]);
  await expect(page.getByRole("region", { name: "코스피 비교" })).toContainText("초과 수익률 +6.00%p");
  await expect(page.getByRole("region", { name: "S&P 500 비교" })).toContainText("기간 데이터가 없습니다");
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "코스피", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "S&P 500", exact: true })).toBeChecked();
  // 저장 실패 시 낙관적으로 해제한 체크를 실제 저장된 선택으로 돌려야 한다.
  failSave = true;
  await page.getByRole("checkbox", { name: "코스피", exact: true }).uncheck();
  await expect(page.getByText("선택 저장 실패")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "코스피", exact: true })).toBeChecked();
  expect(selected).toEqual(["KOSPI", "SP500"]);
  const unavailable = page.getByRole("region", { name: "S&P 500 비교" });
  await unavailable.getByRole("button", { name: "비교 데이터 수집" }).click();
  await expect(unavailable).toContainText("수집 실패");
  await expect(page.getByText("누적 수익률", { exact: true })).toBeVisible();
  await unavailable.getByRole("button", { name: "비교 데이터 수집" }).click();
  await expect.poll(() => attempts).toBe(2);
  await page.getByRole("checkbox", { name: "코스피", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "S&P 500", exact: true }).uncheck();
  await expect.poll(() => selected).toEqual([]);
  await page.reload();
  await expect(page.getByText("선택한 비교 지수가 없습니다.")).toBeVisible();
});
