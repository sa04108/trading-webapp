import { expect, type Page } from '@playwright/test';

/** 유효한 조회 기간을 선택한 뒤 데이터 준비 단계로 이동한다. */
export async function advanceFromPeriod(page: Page): Promise<void> {
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/universe$/);
}
