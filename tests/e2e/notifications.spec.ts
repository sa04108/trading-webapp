import { expect, test } from "@playwright/test";
import { login } from "./login";

// 알림 추가는 데이터가 같은 재조회와 달리 전체 선택의 분모를 바꾼다.
test("새 알림을 받아도 기존 선택과 펼친 설명을 유지한다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  const first = { id: "notification-first", type: "data-sync", severity: "error", title: "기존 알림",
    body: "기존 오류의 상세 설명", link: null, read: false, createdAtMs: Date.now() };
  let notifications = [first];
  await page.route(/\/api\/v1\/notifications(?:\?.*)?$/, (route) => route.fulfill({ json: { notifications, total: notifications.length, selectionCount: notifications.length } }));
  await page.goto("/notifications");
  await page.getByRole("button", { name: "기존 알림 설명 자세히 보기", exact: true }).click();
  await page.getByRole("button", { name: "편집", exact: true }).click();
  const all = page.getByRole("checkbox", { name: "전체 선택", exact: true });
  await page.getByRole("checkbox", { name: "기존 알림 선택", exact: true }).check();
  notifications = [first, { ...first, id: "notification-new", title: "새 알림" }];
  await page.clock.runFor(5_100);
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await expect(page.getByRole("checkbox", { name: "기존 알림 선택", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "새 알림 선택", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "기존 알림 설명 접기", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "삭제 (1)", exact: true })).toBeEnabled();
});

// 목록의 200개 상한과 삭제 범위를 혼동하지 않고 오류 필터 및 개별 제외를 전송한다.
test("알림 전체 선택은 표시 상한 밖의 오류까지 삭제하고 정보 알림과 제외 항목은 남긴다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  const first = { id: "error-0", type: "data-sync", severity: "error", title: "오류 0", body: null, link: null, read: true, createdAtMs: Date.now() };
  let notifications = Array.from({ length: 205 }, (_, i) => ({ ...first, id: `error-${i}`, title: `오류 ${i}` }));
  notifications.push({ ...first, id: "info", title: "정보 알림", severity: "info" });
  const deleted: unknown[] = [];
  await page.route(/\/api\/v1\/notifications(?:\/list)?(?:\?.*)?$/, (route) => {
    if (route.request().method() === "DELETE") {
      const body = route.request().postDataJSON() as { all: true; severity: string; excludeIds: string[] };
      deleted.push(body);
      notifications = notifications.filter((item) => item.severity !== body.severity || body.excludeIds.includes(item.id));
      return route.fulfill({ status: 204 });
    }
    const params = route.request().method() === "POST" ? route.request().postDataJSON() as { severity?: string; excludeIds: string[] } : { severity: new URL(route.request().url()).searchParams.get("severity"), excludeIds: [] };
    const filtered = notifications.filter((item) => !params.severity || item.severity === params.severity);
    const selectionCount = filtered.filter((item) => !params.excludeIds.includes(item.id)).length;
    return route.fulfill({ json: { notifications: filtered.slice(0, 200), total: filtered.length, selectionCount } });
  });
  await page.goto("/notifications");
  await page.getByRole("button", { name: "오류", exact: true }).click();
  await page.getByRole("button", { name: "편집", exact: true }).click();
  const all = page.getByRole("checkbox", { name: "전체 선택", exact: true });
  await page.getByText("전체 선택", { exact: true }).click();
  await expect(page.getByRole("button", { name: "삭제 (205)", exact: true })).toBeEnabled();
  await page.getByRole("checkbox", { name: "오류 0 선택", exact: true }).uncheck();
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await page.getByRole("button", { name: "삭제 (204)", exact: true }).click();
  await expect(page.getByRole("button", { name: "편집", exact: true })).toBeEnabled();
  expect(deleted).toEqual([{ all: true, severity: "error", excludeIds: ["error-0"] }]);
  expect(notifications.map((item) => item.id)).toEqual(["error-0", "info"]);
  await page.getByRole("button", { name: "편집", exact: true }).click();
  await all.focus();
  await page.keyboard.press("Space");
  notifications.unshift({ ...first, id: "error-later", title: "새 오류" });
  await page.clock.runFor(5_100);
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page.getByRole("checkbox", { name: "새 오류 선택", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "오류 0 선택", exact: true }).uncheck();
  await expect(page.getByRole("button", { name: "삭제 (1)", exact: true })).toBeEnabled();
  // 다른 탭에서 제외한 알림을 지워도 남은 알림의 선택 개수는 1이어야 한다.
  notifications = notifications.filter((item) => item.id !== "error-0");
  await page.clock.runFor(5_100);
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page.getByRole("checkbox", { name: "오류 0 선택", exact: true })).toHaveCount(0);
  await expect(all).toBeChecked();
  await page.getByRole("button", { name: "삭제 (1)", exact: true }).click();
  await expect(page.getByText("오류 알림이 없습니다.", { exact: true })).toBeVisible();
  expect(deleted[1]).toEqual({ all: true, severity: "error", excludeIds: ["error-0"] });
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await expect(page.getByText("정보 알림", { exact: true })).toBeVisible();
});
