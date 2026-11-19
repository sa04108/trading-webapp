import { expect, type Page } from '@playwright/test';

/** 준비 대상과 직전 주식수 앵커의 DART 무자료 원문을 제공한다. */
export async function prepareActionRawFixture(page: Page, symbols: string[], years: number[]): Promise<void> {
  const response = await page.request.post('/__e2e/dart-action-fixture', { data: { symbols, years } });
  expect(response.ok()).toBe(true);
}
