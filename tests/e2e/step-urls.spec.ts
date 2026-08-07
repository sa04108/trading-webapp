import { expect, test } from '@playwright/test';
import { login } from './login';

/**
 * 화면 단계 URL(설계 2026-08-07-step-urls-design) — 페이지 단위로 화면이 바뀌는
 * 이동이 이력에 한 칸을 차지하는지 본다. 위저드 폼 채우기 전체 흐름은
 * mvp-flow.spec.ts 가 이미 다루므로 여기서는 URL 과 값 보존만 확인한다.
 */

test('위저드 단계마다 URL 이 있고 뒤로가기가 직전 단계로 돌아간다', async ({ page }) => {
  await login(page);

  // slug 없는 진입은 첫 단계로 이어진다
  await page.goto('/backtests/new');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);

  const strategy = page.getByRole('button', { name: /전고점 돌파/ });
  await strategy.click();
  await expect(strategy).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/period$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);
  // 이 단언이 이 설계의 핵심 전제다 — 같은 라우트에서 param 만 바뀌면 위저드가
  // 재마운트되지 않으므로 폼 값이 살아 있다. 재마운트되면 선택이 풀려 여기서 깨진다.
  await expect(page.getByRole('button', { name: /전고점 돌파/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.goForward();
  await expect(page).toHaveURL(/\/backtests\/new\/period$/);
});

test('갈 수 없는 단계 URL 은 갈 수 있는 마지막 단계로 되돌린다', async ({ page }) => {
  await login(page);

  // 빈 폼으로 검토 단계에 딥링크 — 게이트가 첫 단계로 되돌린다
  await page.goto('/backtests/new/review');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);

  // replace 라서 튕겨 나온 review 가 이력에 없다 — 뒤로가기는 위저드 밖으로 나간다
  await page.goBack();
  await expect(page).not.toHaveURL(/\/backtests\/new/);
});

test('모르는 단계 slug 는 첫 단계로 접힌다', async ({ page }) => {
  await login(page);
  await page.goto('/backtests/new/nonexistent-step');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);
});

test('복제 진입의 ?from= 은 단계를 옮겨도 남는다', async ({ page }) => {
  await login(page);
  // 없는 작업 id 로도 확인할 수 있다 — 초안 조회는 실패하고 위저드가 빈 폼을 보여주지만,
  // 확인 대상은 리다이렉트가 쿼리를 잃지 않는지다.
  await page.goto('/backtests/new?from=bt_nonexistent');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy\?from=bt_nonexistent$/);

  // 진입 리다이렉트만이 아니라 **단계 이동**도 쿼리를 지켜야 한다 — goToSlug 가
  // location.search 를 다시 붙이지 않으면 '다음' 을 누른 순간 복제 맥락이 사라진다.
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/period\?from=bt_nonexistent$/);
});

test('제출 화면 URL 을 직접 열면 검토를 거치도록 되돌린다', async ({ page }) => {
  await login(page);

  // 빈 폼으로 실행 단계 딥링크 — 큐를 검토 없는 제출로부터 지키는 유일한 방어선이다
  await page.goto('/backtests/new/run');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);
  await expect(page.getByRole('button', { name: '백테스트 실행' })).toHaveCount(0);
});

test('데이터 구획은 각자 URL 을 갖고 뒤로가기가 직전 구획으로 돌아간다', async ({ page }) => {
  await login(page);

  await page.goto('/datasets');
  await expect(page).toHaveURL(/\/datasets\/master$/);
  await expect(page.getByRole('link', { name: '종목 마스터' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.getByRole('link', { name: '가격 데이터' }).click();
  await expect(page).toHaveURL(/\/datasets\/prices$/);
  await expect(page.getByRole('link', { name: '가격 데이터' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.goBack();
  await expect(page).toHaveURL(/\/datasets\/master$/);
});

test('옛 ?tab= 링크는 구획 경로로 이어지고 다른 쿼리는 남는다', async ({ page }) => {
  await login(page);

  // 데이터 탭이 데이터셋·종목이던 시절의 값
  await page.goto('/datasets?tab=symbols');
  await expect(page).toHaveURL(/\/datasets\/prices$/);

  await page.goto('/datasets?tab=prices');
  await expect(page).toHaveURL(/\/datasets\/prices$/);

  // ?date= 는 종목 마스터가 쓰는 값이다 — 리다이렉트가 삼키면 날짜 링크가 끊긴다
  await page.goto('/datasets?tab=master&date=2024-12-30');
  await expect(page).toHaveURL(/\/datasets\/master\?date=2024-12-30$/);
});

test('구획을 왕복해도 ?date= 가 남는다', async ({ page }) => {
  await login(page);

  // 보던 시점이 구획 왕복 사이에 사라지면 읽던 스냅샷이 조용히 최신 날짜로 바뀐다
  await page.goto('/datasets/master?date=2024-12-30');
  await page.getByRole('link', { name: '가격 데이터' }).click();
  await expect(page).toHaveURL(/\/datasets\/prices\?date=2024-12-30$/);
  await page.getByRole('link', { name: '종목 마스터' }).click();
  await expect(page).toHaveURL(/\/datasets\/master\?date=2024-12-30$/);
});

test('모르는 데이터 하위 경로도 기본 구획으로 이어진다', async ({ page }) => {
  await login(page);

  // 자식 라우트가 다 어긋나면 매칭 실패가 앱 셸을 라우터 오류 화면으로 바꾼다 —
  // 옛 tab 값을 경로로 손입력한 경우가 대표적이다
  await page.goto('/datasets/symbols');
  await expect(page).toHaveURL(/\/datasets\/master$/);
  await expect(page.getByRole('link', { name: '종목 마스터' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('끝 슬래시가 붙은 경로도 활성 구획을 표시한다', async ({ page }) => {
  await login(page);

  // 같은 경로의 다른 표기 — 라우터는 매칭하므로 화면은 뜨는데, 활성 표시가 문자열
  // 비교면 두 구획 모두 비활성으로 그려져 지금 위치를 알 방법이 없어진다
  await page.goto('/datasets/prices/');
  await expect(page.getByRole('link', { name: '가격 데이터' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
