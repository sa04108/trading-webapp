import { expect, test } from "@playwright/test";
import { login } from "./login";

// 알림 추가는 데이터가 같은 재조회와 달리 전체 선택의 분모를 바꾼다.
test("새 알림을 받아도 기존 선택과 펼친 설명을 유지한다", async ({ page }) => {
  await login(page);
  await page.clock.install();
  const first = { id: "notification-first", type: "data-sync", severity: "error", title: "기존 알림",
    body: "기존 오류의 상세 설명", link: null, read: false, createdAtMs: Date.now() };
  let notifications = [first];
  await page.route(/\/api\/v1\/notifications(?:\?.*)?$/, (route) => route.fulfill({ json: { notifications } }));
  await page.goto("/notifications");
  await page.getByRole("button", { name: "기존 알림 설명 자세히 보기", exact: true }).click();
  await page.getByRole("button", { name: "편집", exact: true }).click();
  const all = page.getByRole("checkbox", { name: "전체 선택", exact: true });
  await all.check();
  notifications = [first, { ...first, id: "notification-new", title: "새 알림" }];
  await page.clock.runFor(5_100);
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await expect(page.getByRole("checkbox", { name: "기존 알림 선택", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "새 알림 선택", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "기존 알림 설명 접기", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "삭제 (1)", exact: true })).toBeEnabled();
});
