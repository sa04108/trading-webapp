import { expect, test } from "@playwright/test";
import type { JobItem } from "../../src/shared/schemas/jobs";
import { login } from "./login";

const createdAtMs = Date.UTC(2026, 0, 1);
const active: JobItem = {
  id: "backtest:run-1", kind: "backtest", title: "진행 작업", status: "RUNNING",
  phase: "계산", description: null, progress: { current: 2, total: 10, percent: 20, label: "계산 중" },
  error: null, createdAtMs, updatedAtMs: createdAtMs, finishedAtMs: null, cancellable: true, link: "/backtests/run-1",
};
const finished: JobItem = {
  ...active, id: "preparation:done-1", kind: "preparation", title: "종료 작업", status: "COMPLETED",
  progress: { current: null, total: null, percent: null, label: "완료" }, finishedAtMs: createdAtMs, cancellable: false,
};

function list(jobs: JobItem[]) {
  return { jobs, total: jobs.length, activeCount: jobs.filter((job) => job.status === "RUNNING" || job.status === "CANCELLING").length, retentionDays: 7, limit: 50, offset: 0 };
}

test("작업 목록에서 종료된 기록만 삭제하고 상세를 연다", async ({ page }) => {
  await login(page);
  let jobs = [active, finished];
  let deleteFails = true;
  let deleted: string[] = [];
  await page.route(/\/api\/v1\/jobs(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "DELETE") {
      deleted = (route.request().postDataJSON() as { ids: string[] }).ids;
      if (deleteFails) return route.fulfill({ status: 400, json: { error: "삭제할 수 없습니다" } });
      jobs = jobs.filter((job) => !deleted.includes(job.id));
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: list(jobs) });
  });
  await page.route(/\/api\/v1\/jobs\/[^/]+$/, (route) => route.fulfill({ json: { job: finished } }));
  await page.route(/\/api\/v1\/jobs\/[^/]+\/cancel$/, (route) => route.fulfill({ status: 409, json: { error: "취소할 수 없습니다" } }));

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const jobsButton = page.getByRole("link", { name: "작업", exact: true });
    const bell = page.getByRole("button", { name: /^알림/ });
    const jobsBox = await jobsButton.boundingBox();
    const bellBox = await bell.boundingBox();
    expect(jobsBox).not.toBeNull();
    expect(bellBox).not.toBeNull();
    expect(jobsBox!.x + jobsBox!.width).toBeLessThanOrEqual(bellBox!.x);
    expect(bellBox!.x + bellBox!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.getByRole("link", { name: "작업", exact: true }).click();
  await expect(page.getByText("진행 작업")).toBeVisible();
  await expect(page.getByText("종료된 작업 기록은 7일간 보관됩니다.", { exact: false })).toBeVisible();
  await expect(page.locator(`a[href="/jobs/${encodeURIComponent(active.id)}"]`).getByText("계산", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "진행 작업 작업 열기" })).toHaveAttribute("href", "/backtests/run-1");
  await page.getByRole("button", { name: "진행 작업 취소" }).click();
  await expect(page.getByRole("alert")).toContainText("취소할 수 없습니다");
  await page.getByRole("button", { name: "편집" }).click();
  await expect(page.getByRole("checkbox", { name: "진행 작업 선택" })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "종료된 작업 전체 선택" }).check();
  await page.getByRole("button", { name: "삭제 (1)" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "삭제할 수 없습니다" })).toBeVisible();
  expect(deleted).toEqual([finished.id]);
  deleteFails = false;
  await page.getByRole("button", { name: "삭제 (1)" }).click();
  await expect(page.getByText("종료 작업")).toHaveCount(0);
  await expect(page.getByText("진행 작업")).toBeVisible();

  jobs = [active, finished];
  await page.reload();
  await page.locator(`a[href="/jobs/${encodeURIComponent(finished.id)}"]`).click();
  await expect(page).toHaveURL(/\/jobs\/preparation%3Adone-1$/i);
  await expect(page.getByText("완료", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("작업 상세가 진행과 취소 상태를 갱신하고 종료 후 조회를 멈춘다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  let current: JobItem = active;
  let reads = 0;
  let cancelFails = true;
  await page.route(/\/api\/v1\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: list([current]) }));
  await page.route(/\/api\/v1\/jobs\/[^/]+(?:\/cancel)?$/, async (route) => {
    if (route.request().method() === "POST") {
      if (cancelFails) return route.fulfill({ status: 409, json: { error: "취소할 수 없습니다" } });
      current = { ...current, status: "CANCELLING", cancellable: false };
      return route.fulfill({ json: { job: current } });
    }
    reads += 1;
    return route.fulfill({ json: { job: current } });
  });
  await page.goto(`/jobs/${encodeURIComponent(active.id)}`);
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
  current = { ...current, progress: { current: 6, total: 10, percent: 60, label: "계산 중" } };
  await page.clock.runFor(2_100);
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
  await page.getByRole("button", { name: "작업 취소" }).click();
  await expect(page.getByRole("alert")).toContainText("취소할 수 없습니다");
  cancelFails = false;
  await page.getByRole("button", { name: "작업 취소" }).click();
  await expect(page.getByText("취소 중", { exact: true })).toBeVisible();
  current = { ...current, status: "CANCELLED", finishedAtMs: createdAtMs };
  await page.clock.runFor(2_100);
  await expect(page.getByText("취소됨", { exact: true })).toBeVisible();
  const terminalReads = reads;
  await page.clock.runFor(10_000);
  expect(reads).toBe(terminalReads);
  await page.getByRole("link", { name: "작업", exact: true }).click();
  await page.clock.runFor(10_000);
  expect(reads).toBe(terminalReads);
});
