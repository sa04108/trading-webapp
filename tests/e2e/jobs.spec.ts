import { expect, test } from "@playwright/test";
import { isFinishedJob, type JobItem } from "../../src/shared/schemas/jobs";
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
  return { jobs, total: jobs.length, selectionCount: jobs.filter((job) => isFinishedJob(job.status)).length, finishedCount: jobs.filter((job) => isFinishedJob(job.status)).length, activeCount: jobs.filter((job) => job.status === "RUNNING" || job.status === "CANCELLING").length, retentionDays: 7, limit: 50, offset: 0 };
}

// 고정 목록의 삭제 검증과 달리 완료 상태 전환은 선택 가능한 항목 수 자체를 바꾼다.
test("갱신으로 종료 작업이 늘면 기존 선택을 유지하고 일부 선택으로 표시한다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  let jobs = [active, finished];
  let reads = 0;
  await page.route(/\/api\/v1\/jobs(?:\?.*)?$/, (route) => {
    reads++;
    return route.fulfill({ json: list(jobs) });
  });
  await page.goto("/jobs");
  await page.getByRole("button", { name: "편집", exact: true }).click();
  const all = page.getByRole("checkbox", { name: "종료된 작업 전체 선택", exact: true });
  await page.getByRole("checkbox", { name: "종료 작업 선택", exact: true }).check();
  const before = reads;
  await page.clock.runFor(5_100);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(all).toBeChecked();
  jobs = [{ ...active, status: "COMPLETED", finishedAtMs: createdAtMs, cancellable: false }, finished];
  await page.clock.runFor(5_100);
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await expect(page.getByRole("checkbox", { name: "종료 작업 선택", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "진행 작업 선택", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "삭제 (1)", exact: true })).toBeEnabled();
  await all.click();
  await expect(all).toBeChecked();
  await expect(page.getByRole("button", { name: "삭제 (2)", exact: true })).toBeEnabled();
});

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
  await page.getByRole("checkbox", { name: "종료 작업 선택", exact: true }).check();
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

// 전체 선택의 범위는 페이지 ID가 아니라 필터에 맞는 모든 종료 이력이다.
test("전체 선택은 페이지와 갱신을 넘어 유지되고 제외한 오류 이력만 남긴다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  let jobs: JobItem[] = Array.from({ length: 120 }, (_, index) => ({ ...finished, id: `backtest:failed-${index}`, title: `실패 ${index}`, status: "FAILED" }));
  jobs.push(active, finished);
  let reads = 0;
  let deleted: unknown;
  await page.route(/\/api\/v1\/jobs(?:\/list)?(?:\?.*)?$/, (route) => {
    const request = route.request();
    if (request.method() === "DELETE") {
      const body = request.postDataJSON() as { all: true; status: string; excludeIds: string[] };
      deleted = body;
      jobs = jobs.filter((job) => job.status !== "FAILED" || body.excludeIds.includes(job.id));
      return route.fulfill({ status: 204 });
    }
    reads++;
    const url = new URL(request.url());
    const params = request.method() === "POST" ? request.postDataJSON() as { status: string; offset: number; excludeIds: string[] } : { status: url.searchParams.get("status"), offset: Number(url.searchParams.get("offset")), excludeIds: [] };
    const filtered = params.status === "error" ? jobs.filter((job) => job.status === "FAILED") : jobs;
    const selectionCount = filtered.filter((job) => isFinishedJob(job.status) && !params.excludeIds.includes(job.id)).length;
    const offset = Math.min(params.offset, Math.max(0, Math.floor((filtered.length - 1) / 50) * 50));
    return route.fulfill({ json: { ...list(filtered), selectionCount, jobs: filtered.slice(offset, offset + 50), offset } });
  });
  await page.goto("/jobs");
  await page.getByRole("button", { name: "오류", exact: true }).click();
  await page.getByRole("button", { name: "편집", exact: true }).click();
  const all = page.getByRole("checkbox", { name: "종료된 작업 전체 선택", exact: true });
  await page.getByText("전체 선택", { exact: true }).click();
  await expect(all).toBeChecked();
  // 같은 페이지의 항목이 모두 바뀌어도 전체 선택이 해제되면 안 된다.
  jobs = [...jobs.slice(50, 120), ...jobs.slice(0, 50), active, finished];
  const before = reads;
  await page.clock.runFor(30_100);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(page.getByRole("checkbox", { name: "실패 50 선택", exact: true })).toBeVisible();
  await expect(all).toBeChecked();
  await expect(page.getByRole("button", { name: "삭제 (120)", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "실패 100 선택", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "실패 100 선택", exact: true }).uncheck();
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await page.getByRole("button", { name: "삭제 (119)", exact: true }).click();
  await expect(page.getByRole("button", { name: "편집", exact: true })).toBeEnabled();
  expect(deleted).toEqual({ all: true, status: "error", excludeIds: ["backtest:failed-100"] });
  expect(jobs.map((job) => job.id)).toEqual(["backtest:failed-100", active.id, finished.id]);
  await expect(page.getByText("실패 100", { exact: true })).toBeVisible();
});

test("삭제 후 재조회가 끝나기 전에는 재선택을 막고 이어서 다른 기록을 삭제한다", async ({ page }) => {
  await login(page);
  const second = { ...finished, id: "preparation:done-2", title: "다음 종료 작업" };
  let jobs = [finished, second];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deleted: string[][] = [];
  let refreshing = false;
  await page.route(/\/api\/v1\/jobs(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "DELETE") {
      const ids = (route.request().postDataJSON() as { ids: string[] }).ids;
      deleted.push(ids);
      jobs = jobs.filter((job) => !ids.includes(job.id));
      return route.fulfill({ status: 204 });
    }
    if (deleted.length === 1) { refreshing = true; await gate; }
    return route.fulfill({ json: list(jobs) });
  });
  try {
    await page.goto("/jobs");
    await page.getByRole("button", { name: "편집", exact: true }).click();
    await page.getByRole("checkbox", { name: "종료 작업 선택", exact: true }).check();
    await page.getByRole("button", { name: "삭제 (1)", exact: true }).click();
    await expect.poll(() => refreshing).toBe(true);
    await expect(page.getByRole("button", { name: "완료", exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "종료된 작업 전체 선택", exact: true })).toBeDisabled();
    expect(deleted).toEqual([[finished.id]]);
    release();
    await expect(page.getByRole("button", { name: "편집", exact: true })).toBeEnabled();
    await expect(page.getByText("종료 작업", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "편집", exact: true }).click();
    await page.getByRole("checkbox", { name: "다음 종료 작업 선택", exact: true }).check();
    await page.getByRole("button", { name: "삭제 (1)", exact: true }).click();
    await expect(page.getByText("작업이 없습니다.", { exact: true })).toBeVisible();
    expect(deleted).toEqual([[finished.id], [second.id]]);
  } finally { release(); }
});
