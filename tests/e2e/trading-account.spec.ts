import { expect, test } from "@playwright/test";
import { login } from "./login";

const accounts = [
  { id: "account-1", label: "계좌 1" },
  { id: "account-2", label: "계좌 2" },
  { id: "account-3", label: "계좌 3" },
];
const snapshot = {
  revision: 17,
  deployment: null,
  broker: {
    provider: "TOSS",
    configured: true,
    accounts,
    selectedAccountId: "account-2",
    lastSyncAtMs: null,
    error: null,
  },
  account: null,
  performance: null,
  positions: [],
  orders: [],
  events: [],
  blockers: [],
};

test("계좌 목록을 아래로 열고 키보드로 선택한다", async ({ page }) => {
  await login(page);
  let current = snapshot;
  await page.route("**/api/v1/trading", (route) => route.fulfill({ json: current }));
  await page.route("**/api/v1/trading/strategies", (route) => route.fulfill({ json: { strategies: [] } }));
  let submitted: unknown;
  await page.route("**/api/v1/trading/account", (route) => {
    submitted = { method: route.request().method(), body: route.request().postDataJSON() };
    current = { ...snapshot, revision: 18, broker: { ...snapshot.broker, selectedAccountId: "account-3" } };
    return route.fulfill({ json: current });
  });
  await page.goto("/trading");
  // Radix 메뉴가 열리면 배경 트리거가 접근성 트리에서 숨겨져도 화면 좌표는 확인한다.
  const trigger = page.getByRole("combobox", { name: "계좌 선택", includeHidden: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  if (!triggerBox || !menuBox) throw new Error("계좌 선택기를 찾을 수 없습니다");
  expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 1);
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => submitted).toEqual({ method: "PUT", body: { expectedRevision: 17, accountId: "account-3" } });
  await expect(trigger).toContainText("계좌 3");
});
