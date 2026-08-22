import { expect, type Page } from '@playwright/test';

/**
 * 기간 단계의 벤치마크 커버리지 게이트를 통과한다.
 *
 * 이미 커버된 기간은 첫 [다음]에서 바로 이동하고, 처음 보는 기간은 [동기화]가
 * 나타난 뒤 백필 완료를 기다려 한 번 더 진행한다. 파일마다 이 분기를 복사하면 먼저
 * 실행된 프로젝트가 남긴 DB 상태에 따라 테스트가 흔들리므로 한 곳에서 처리한다.
 */
export async function advanceFromPeriod(
  page: Page,
  options: { backfillTimeoutMs?: number } = {},
): Promise<void> {
  const backfillTimeoutMs = options.backfillTimeoutMs ?? 180_000;
  const next = page.getByRole('button', { name: '다음', exact: true });
  const sync = page.getByRole('button', { name: '동기화', exact: true });

  await next.click();
  await expect.poll(async () => {
    if (/\/backtests\/new\/universe$/.test(new URL(page.url()).pathname)) return 'advanced';
    if (await sync.isVisible()) return 'sync';
    return 'waiting';
  }).not.toBe('waiting');

  if (/\/backtests\/new\/universe$/.test(new URL(page.url()).pathname)) return;

  await sync.click();
  await expect(next).toBeEnabled({ timeout: backfillTimeoutMs });
  await next.click();
  await expect(page).toHaveURL(/\/backtests\/new\/universe$/);
}
