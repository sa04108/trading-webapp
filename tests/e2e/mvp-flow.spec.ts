import { expect, test } from '@playwright/test';

const USERNAME = 'e2e-operator';
const PASSWORD = 'correct-horse-battery-staple';

/** 스펙 §33 E2E 흐름: 로그인 → 생성 → 제출 → 완료 → 결과 → 거래 필터 → clone → 로그아웃 */
test('full MVP flow', async ({ page }) => {
  // 1. 로그인 (비밀번호 단일 단계, D-014)
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  // 2. 백테스트 생성 (6단계 위저드) — 픽스처에서 완결 거래가 나오도록 파라미터 조정
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /시간봉 돌파/ }).click();
  await page.getByLabel('lookbackBars').fill('10');
  await page.getByLabel('atrPeriod').fill('5');
  await page.getByLabel(/takeProfitAtrMultiplier/).fill('3');
  await page.getByRole('button', { name: '다음' }).click();

  await page.getByRole('button', { name: /kr-hourly-v1/ }).click();
  await page.getByRole('button', { name: '다음' }).click();

  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-03-31');
  await page.getByRole('button', { name: '다음' }).click();

  await page.getByRole('button', { name: '다음' }).click(); // 자본·비용 기본값
  await page.getByRole('button', { name: '다음' }).click(); // 검토

  // 3. 작업 제출
  await page.getByRole('button', { name: '백테스트 실행' }).click();
  await expect(page).toHaveURL(/\/backtests\/bt_/);

  // 4. 완료 대기 (SSE 진행률 → 완료 badge)
  await expect(page.getByText('완료', { exact: true })).toBeVisible({ timeout: 90_000 });

  // 5. 결과 조회: 지표 카드 + 차트 + 거래 내역
  await expect(page.getByText('누적 수익률')).toBeVisible();
  await expect(page.getByText('자산 곡선')).toBeVisible();
  await expect(page.getByText('월별 수익률')).toBeVisible();
  await expect(page.getByText('거래 내역')).toBeVisible();
  await expect(page.getByText('재현 정보')).toBeVisible();
  const tradeRows = page.getByRole('row').filter({ hasText: '005930' });
  await expect(tradeRows.first()).toBeVisible();

  // 6. 거래 필터 (종목 선택)
  await page.getByRole('combobox', { name: '종목 필터' }).click();
  await page.getByRole('option', { name: '005930' }).click();
  await expect(tradeRows.first()).toBeVisible();

  // 7. clone → 새 작업 페이지
  const originalUrl = page.url();
  await page.getByRole('button', { name: '복제', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/bt_/);
  await expect
    .poll(() => page.url(), { timeout: 10_000 })
    .not.toBe(originalUrl);

  // 8. 데이터 검증 차트 — 심볼 클릭 → 봉차트 드로어
  await page.goto('/datasets');
  await page.getByRole('button', { name: '005930', exact: true }).click();
  await expect(page.getByText(/데이터 검증/)).toBeVisible();
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/candle-inspect.png' });
  await page.keyboard.press('Escape');

  // 9. 로그아웃
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

test('mobile layout has no horizontal scroll on core screens (스펙 §38)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile 전용 검증');

  await page.goto('/login');
  await page.getByLabel('사용자 이름').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();

  for (const path of ['/', '/backtests', '/datasets', '/settings']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} 가로 스크롤`).toBeLessThanOrEqual(0);
  }
});
