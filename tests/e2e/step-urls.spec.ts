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

test('재설정 및 복제의 전략 단계는 종목과 비용 프로필을 미리 조회하지 않는다', async ({
  page,
}) => {
  await login(page);

  await page.route('**/api/v1/backtests/bt_clone_fixture/clone-draft', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        request: {
          strategyId: 'range-breakout',
          parameters: {
            lookbackBars: 10,
            atrPeriod: 5,
            stopAtrMultiplier: 2,
            takeProfitAtrMultiplier: 3,
            riskPerTradePercent: 2,
          },
          universeRule: {
            markets: ['KOSPI'],
            stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
            rebalanceInterval: { value: 1, unit: 'MONTH' },
          },
          timeframe: '1d',
          period: { from: '2026-01-05', to: '2026-03-31' },
          capital: { initialCash: 10_000_000, currency: 'KRW' },
          execution: {
            fillTiming: 'NEXT_BAR_OPEN',
            commissionProfileId: 'kr-equity-default',
            slippageProfileId: 'fixed-5bps',
          },
          risk: { maxPositions: 5 },
          randomSeed: 42,
        },
        warnings: [],
        blockers: [],
      }),
    });
  });

  // 새 문서 탐색으로 앱의 Query cache를 비운 뒤 이 진입에서 발생한 요청만 관찰한다.
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/v1/')) apiRequests.push(pathname);
  });

  await page.goto('/backtests/new/strategy?from=bt_clone_fixture');
  await expect(page.getByRole('heading', { name: '재설정 및 복제' })).toBeVisible();
  await expect(page.getByRole('button', { name: /전고점 돌파/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // schema 조회와 프리필까지 끝난 안정 시점 — mount 직후만 보고 금지 요청을 단언하지 않는다.
  await expect(page.getByLabel('돌파 기준 봉 수', { exact: true })).toHaveValue('10');

  expect(apiRequests).toContain('/api/v1/backtests/bt_clone_fixture/clone-draft');
  expect(apiRequests).toContain('/api/v1/strategies');
  expect(apiRequests).toContain('/api/v1/strategies/range-breakout/schema');
  expect(apiRequests).not.toContain('/api/v1/backtests/universe-preview');
  expect(apiRequests).not.toContain('/api/v1/symbols');
  expect(apiRequests).not.toContain('/api/v1/backtests/profiles');
});

test('제출 화면 URL 을 직접 열면 검토를 거치도록 되돌린다', async ({ page }) => {
  await login(page);

  // 빈 폼으로 실행 단계 딥링크 — 큐를 검토 없는 제출로부터 지키는 유일한 방어선이다
  await page.goto('/backtests/new/run');
  await expect(page).toHaveURL(/\/backtests\/new\/strategy$/);
  await expect(page.getByRole('button', { name: '백테스트 실행' })).toHaveCount(0);
});

// 데이터 화면은 구획이 종목 마스터 하나뿐이다(가격 데이터 구획은
// 2026-08-07-price-data-removal 계획으로 제거됐다) — 그래서 탭 nav 자체가 없다
// (data-page.tsx). 아래 시나리오는 구획 간 이동이 아니라 `/datasets` 진입·리다이렉트가
// `/datasets/master`로 정확히 이어지는지, 그리고 그 경로가 쿼리를 잃지 않는지만 본다.

test('옛 ?tab= 링크는 종목 마스터 경로로 이어지고 다른 쿼리는 남는다', async ({ page }) => {
  await login(page);

  // 데이터 탭이 데이터셋·종목이던 시절의 값. 가격 데이터 구획이 있던 시절의
  // ?tab=prices 도 지금은 구획이 하나뿐이라 같은 곳(종목 마스터)으로 이어진다.
  await page.goto('/datasets?tab=symbols');
  await expect(page).toHaveURL(/\/datasets\/master$/);

  await page.goto('/datasets?tab=prices');
  await expect(page).toHaveURL(/\/datasets\/master$/);

  // ?date= 는 종목 마스터가 쓰는 값이다 — 리다이렉트가 삼키면 날짜 링크가 끊긴다
  await page.goto('/datasets?tab=master&date=2024-12-30');
  await expect(page).toHaveURL(/\/datasets\/master\?date=2024-12-30$/);
});

test('모르는 데이터 하위 경로도 기본 구획으로 이어진다', async ({ page }) => {
  await login(page);

  // 자식 라우트가 다 어긋나면 매칭 실패가 앱 셸을 라우터 오류 화면으로 바꾼다 —
  // 옛 tab 값을 경로로 손입력한 경우가 대표적이다. 탭 nav 가 없으므로 화면 확인은
  // 종목 마스터에만 있는 컨트롤(자동 동기화 체크박스)로 한다.
  await page.goto('/datasets/symbols');
  await expect(page).toHaveURL(/\/datasets\/master$/);
  await expect(page.getByRole('checkbox', { name: '자동 동기화(KRX)' })).toBeVisible();
});
