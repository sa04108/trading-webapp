import { expect, test, type Page } from '@playwright/test';
import { login } from './login';

const strategy = {
  id: 'deterministic-fixture', version: '1.0.0', name: '난수 비의존 검증 전략',
  description: '위저드 검증용 전략', requiresFundamentals: false, supportsRandomSeed: false,
};
const period = { from: '2026-01-05', to: '2026-03-31' };
const universeRule = {
  markets: ['KOSPI'],
  stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
  rebalanceInterval: { value: 1, unit: 'MONTH' },
};
async function restoreWizard(page: Page, step: string): Promise<void> {
  const payloads: Record<string, unknown> = {
    strategy: { strategyId: strategy.id, parameters: {}, currentStep: step },
    period,
    universe: {
      universeRule,
      lastPreview: {
        params: { universeRule, period, strategyId: strategy.id, parameters: {} },
        result: {
          schedule: [{ rebalanceDate: period.from, effectiveDate: period.from, members: [{ symbol: '005930' }] }],
          unionSymbols: ['005930'], scheduleHash: 'fixture', periodCovered: true,
          uncoveredDates: [], missingCandleSymbols: [], warnings: [],
        },
      },
    },
    capital: {
      initialCash: '10000000', maxPositions: '10', commissionProfileId: 'kr-equity-default',
      slippageProfileId: 'fixed-5bps', randomSeed: '과거의 잘못된 입력',
    },
  };
  await page.route('**/api/v1/strategies', (route) => route.fulfill({ json: { strategies: [strategy] } }));
  await page.route(`**/api/v1/strategies/${strategy.id}/schema`, (route) =>
    route.fulfill({ json: { schema: { type: 'object', properties: {} } } }));
  await page.route('**/api/v1/backtests/wizard-draft/*?*', (route) => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1)!;
    return route.fulfill({ json: { draft: { payload: payloads[key] } } });
  });
  await page.route('**/api/v1/backtests/wizards/fixture-wizard', route => route.fulfill({ json: { wizard: {
    id: 'fixture-wizard', sourceJobId: null, currentStep: step, status: 'WAITING', phase: 'DRAFT', error: null,
    preparationJobId: null, preparationInput: null, backtestJobId: null, createdAtMs: 1, updatedAtMs: 1, finishedAtMs: null, link: '/backtests/new/capital?wizard=fixture-wizard',
  } } }));
  await page.goto(`/backtests/new/${step}?wizard=fixture-wizard`);
  await expect(page).toHaveURL(new RegExp(`/backtests/new/${step}\\?wizard=`));
}

test('난수 비의존 전략의 입력은 비활성화하고 과거 시드 오류는 제출을 막지 않는다', async ({ page }) => {
  await login(page);
  await restoreWizard(page, 'capital');
  const weight = page.getByLabel('종목별 최대 비중 (%)');
  await expect(weight).toHaveValue('');
  await weight.fill('0');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page.getByText('종목별 최대 비중은 0보다 크고 100 이하여야 합니다')).toBeVisible();
  await weight.fill('101');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page.getByText('종목별 최대 비중은 0보다 크고 100 이하여야 합니다')).toBeVisible();
  await weight.fill('12.5');
  await expect(page.getByLabel('난수 시드')).toBeDisabled();
  await expect(page.getByLabel('난수 시드')).toHaveValue('');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/review\?wizard=/);
  await expect(page.getByText('난수 시드는', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/run\?wizard=/);

  await expect(page.getByText('12.5%', { exact: true })).toBeVisible();
  let submittedSeed: unknown;
  let submittedWeight: unknown;
  await page.route('**/api/v1/backtests?*', (route) => {
    submittedSeed = route.request().postDataJSON().randomSeed;
    submittedWeight = route.request().postDataJSON().risk.maxPositionWeightPercent;
    return route.fulfill({ status: 400, json: { error: '제출 값 확인 완료' } });
  });
  await page.getByRole('button', { name: '백테스트 실행', exact: true }).click();
  await expect.poll(() => submittedSeed).toBe(42);
  expect(submittedWeight).toBe(12.5);
});
