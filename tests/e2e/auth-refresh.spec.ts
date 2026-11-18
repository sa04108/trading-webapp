import { expect, test, type Page } from "@playwright/test";

async function mockJobs(page: Page) {
  await page.route("**/api/v1/notifications/**", (route) => route.fulfill({ json: { count: 0 } }));
  await page.route("**/api/v1/jobs?**", (route) => route.fulfill({ json: {
    jobs: [{ id: "backtest:done", kind: "backtest", title: "선택한 작업", status: "COMPLETED",
      phase: null, description: null, progress: null, error: null, createdAtMs: 1, updatedAtMs: 1,
      finishedAtMs: 1, cancellable: false, link: null }],
    total: 1, activeCount: 0, finishedCount: 1, selectionCount: 1, retentionDays: 7, limit: 50, offset: 0,
  } }));
}

// 로그인 성공만 확인하던 기존 테스트는 재연결 시 인증 조회 실패가 화면 전체를 없애는 문제를 놓쳤다.
test("인증 재조회 실패와 복구는 편집을 유지하고 실제 만료만 로그인으로 이동한다", async ({ page }) => {
  await page.clock.install();
  await mockJobs(page);
  let status = 200;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill(status === 200
    ? { json: { id: "audit", username: "audit" } }
    : { status, json: { error: "인증 조회 실패" } }));
  await page.goto("/jobs");
  await page.getByRole("button", { name: "편집", exact: true }).click();
  const selected = page.getByRole("checkbox", { name: "선택한 작업 선택", exact: true });
  await selected.check();
  await selected.focus();
  status = 503;
  await page.clock.runFor(61_000);
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  const retry = page.getByRole("button", { name: "로그인 상태 다시 확인", exact: true });
  await expect(retry).toBeVisible();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(selected).toBeChecked();
  await expect(selected).toBeFocused();
  status = 200;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(selected).toBeChecked();
  status = 401;
  await page.clock.runFor(61_000);
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page).toHaveURL(/\/login$/);
  await expect(selected).toHaveCount(0);
});

test("최초 인증 조회의 일시 오류는 로그인 만료로 오인하지 않고 재시도한다", async ({ page }) => {
  await mockJobs(page);
  let available = false;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill(available
    ? { json: { id: "audit", username: "audit" } }
    : { status: 503, json: { error: "일시 오류" } }));
  await page.goto("/jobs");
  await expect(page.getByRole("button", { name: "로그인 상태 다시 확인", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(page.getByRole("button", { name: "편집", exact: true })).toHaveCount(0);
  available = true;
  await page.getByRole("button", { name: "로그인 상태 다시 확인", exact: true }).click();
  await expect(page.getByRole("button", { name: "편집", exact: true })).toBeVisible();
});
