import { expect, test, type Page } from '@playwright/test';
import { login } from './login';
import { buildPeriodValidationPlan, getValidationOptimization, type PeriodValidationConfig, type PeriodValidationDto, type ValidationTrialDto } from '../../src/shared/schemas/period-validation.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';

const id = 'bt_period_validation';
const request: BacktestRequest = {
  strategyId: 'range-breakout', parameters: { lookbackDays: 20 },
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 10 }], rebalanceInterval: { unit: 'MONTH', value: 1 } },
  period: { from: '2020-01-01', to: '2024-04-15' },
  capital: { initialCash: 10_000_000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'kr-equity-default', slippageProfileId: 'fixed-5bps' },
  risk: { maxPositions: 5 }, randomSeed: 42,
};
const metrics = { initialCash: 10_000_000, finalEquity: 11_000_000, totalReturnPct: 10, cagrPct: 3, maxDrawdownPct: -5, sharpe: 1, tradeCount: 12, winRate: 50, totalCommission: 100, totalTax: 100, totalSlippage: 100 };

async function setup(page: Page) {
  await login(page);
  await page.route(`**/api/v1/backtests/${id}`, (route) => route.fulfill({ json: {
    job: { id, request, status: 'COMPLETED', strategyId: request.strategyId, createdAtMs: 1, startedAtMs: 1, completedAtMs: 2, cloneBatchId: null, cloneSourceJobId: null, error: null },
    run: null, metrics, benchmark: null, provenancePin: null, universeRebalancing: [],
  } }));
  await page.route(`**/api/v1/backtests/${id}/series`, (route) => route.fulfill({ json: { equity: [], benchmark: [], drawdown: [], monthly: [], symbols: [], totalEquityPoints: 0 } }));
  await page.route(`**/api/v1/backtests/${id}/trades?**`, (route) => route.fulfill({ json: { trades: [], total: 0 } }));
  await page.route('**/api/v1/strategies/range-breakout/schema', (route) => route.fulfill({ json: { schema: { type: 'object', properties: { lookbackDays: { type: 'integer', title: '관찰 기간', minimum: 1, maximum: 200, default: 20 } }, required: ['lookbackDays'] } } }));
  const state: { experiments: PeriodValidationDto[]; submitted: PeriodValidationConfig | null; deletedDetailReads: number } = { experiments: [], submitted: null, deletedDetailReads: 0 };
  await page.route(`**/api/v1/backtests/${id}/validations`, async (route) => {
    if (route.request().method() === 'POST') {
      const config = route.request().postDataJSON() as PeriodValidationConfig;
      state.submitted = config;
      const plan = buildPeriodValidationPlan(request, config);
      const trials: ValidationTrialDto[] = plan.folds.flatMap((fold) => [
        ...plan.candidates.map((parameters, candidate): ValidationTrialDto => ({
          id: `train-${fold.ordinal}-${candidate}`, fold: fold.ordinal, role: 'TRAIN', candidate,
          parameters, period: fold.train, jobId: null, status: 'PENDING', progress: null,
          error: null, metrics: null, skipReason: null, selection: null,
        })),
        { id: `oos-${fold.ordinal}`, fold: fold.ordinal, role: 'OOS', candidate: null, parameters: null,
          period: fold.test, jobId: null, status: 'PENDING', progress: null, error: null, metrics: null, skipReason: null, selection: null },
        ...(!getValidationOptimization(config) ? [] : [{ id: `baseline-${fold.ordinal}`, fold: fold.ordinal, role: 'BASELINE' as const,
          candidate: null, parameters: request.parameters, period: fold.test, jobId: null, status: 'PENDING', progress: null, error: null, metrics: null, skipReason: null, selection: null }]),
      ]);
      state.experiments = [{ id: 'val_test', sourceJobId: id, status: 'ACTIVE', config, plan, initialCash: request.capital.initialCash, createdAtMs: 1, error: null, trials }];
      await route.fulfill({ status: 201, json: { experiment: state.experiments[0] } });
    } else await route.fulfill({ json: { experiments: state.experiments } });
  });
  await page.route('**/api/v1/backtest-validations/val_test', async (route) => {
    if (route.request().method() === 'DELETE') {
      state.experiments = [];
      await route.fulfill({ status: 204 });
    } else if (!state.experiments[0]) {
      state.deletedDetailReads++;
      await route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
    } else await route.fulfill({ json: { experiment: state.experiments[0] } });
  });
  await page.route('**/api/v1/backtest-validations/val_test/cancel', async (route) => {
    state.experiments[0]!.status = 'CANCELLED';
    await route.fulfill({ json: { experiment: state.experiments[0] } });
  });
  await page.goto(`/backtests/${id}/validations`);
  return state;
}

test('홀드아웃의 독립 실행 의미와 두 구간을 확인하고 실행한다', async ({ page }) => {
  const state = await setup(page);
  const section = page.getByRole('region', { name: '기간 검증' });
  await section.getByRole('button', { name: '홀드아웃 설명', exact: true }).click();
  await expect(page.getByRole('tooltip')).toContainText('기간을 IS와 OOS로 한 번 나누고');
  await page.keyboard.press('Escape');
  await section.getByLabel('OOS 시작일').fill('2023-01-01');
  await expect(section.getByText('1개 구간 · 후보 1개 · 백테스트 총 2회')).toBeVisible();
  await expect(section.getByText('2020-01-01 ~ 2022-12-31', { exact: true })).toBeVisible();
  await expect(section.getByText(/무포지션 상태에서 다시 실행/)).toBeVisible();
  await section.getByLabel('OOS 시작일').fill('2020-01-01');
  await expect(section.getByRole('button', { name: '검증 실험 실행' })).toBeDisabled();
  await section.getByLabel('OOS 시작일').fill('2023-01-01');
  await section.getByRole('button', { name: '검증 실험 실행' }).click();
  await expect.poll(() => state.submitted).toEqual({ mode: 'HOLDOUT', splitDate: '2023-01-01' });
  await section.getByRole('link', { name: '상세 보기' }).click();
  await expect(page).toHaveURL('/backtests/validations/val_test');
  await page.getByRole('button', { name: '실험 취소' }).click();
  await expect(page.getByText('홀드아웃 · 취소', { exact: true })).toBeVisible();
  // 전용 상세에서 삭제한 실험을 다시 조회하면 정상 삭제 직후 404 화면이 나타난다.
  await page.getByRole('button', { name: '실험 삭제', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page).toHaveURL(`/backtests/${id}/validations`);
  await expect(page.getByText('아직 검증 실험이 없습니다.')).toBeVisible();
  expect(state.deletedDetailReads).toBe(0);
});

test('워크포워드의 후보·고정 전략 실행량과 제외 구간을 표시한다', async ({ page }) => {
  const state = await setup(page);
  const section = page.getByRole('region', { name: '기간 검증' });
  await section.getByLabel('검증 방식', { exact: true }).click();
  await page.getByRole('option', { name: '워크포워드', exact: true }).click();
  await expect(section.getByLabel('파라미터 최적화')).not.toBeChecked();
  await expect(section.getByText('2개 구간 · 후보 1개 · 백테스트 총 4회', { exact: true })).toBeVisible();
  await expect(section.getByLabel('후보값 (쉼표 구분)')).toHaveCount(0);
  await section.getByRole('button', { name: '검증 실험 실행' }).click();
  await expect.poll(() => state.submitted).toEqual({ mode: 'WALK_FORWARD', trainMonths: 36, testMonths: 6 });
  await section.getByLabel('파라미터 최적화').check();
  await section.getByLabel('탐색 매개변수 1').click();
  await page.getByRole('option', { name: '관찰 기간' }).click();
  await section.getByLabel('후보값 (쉼표 구분)').fill('10, 20');
  await expect(section.getByText('2개 구간 · 후보 2개 · 백테스트 총 8회 (고정 전략 OOS 비교 포함)')).toBeVisible();
  await section.getByLabel('파라미터 최적화').uncheck();
  await section.getByLabel('파라미터 최적화').check();
  await expect(section.getByLabel('후보값 (쉼표 구분)')).toHaveValue('10, 20');
  await expect(section.getByText(/평가 기간보다 짧아 제외한 마지막 구간: 2024-01-01 ~ 2024-04-15/)).toBeVisible();
  await section.getByRole('button', { name: '검증 실험 실행' }).click();
  await expect.poll(() => state.submitted).toEqual({ mode: 'WALK_FORWARD', trainMonths: 36, testMonths: 6,
    optimization: { axes: [{ key: 'lookbackDays', values: [10, 20] }], objective: 'sharpe', minTrades: 5, maxDrawdownPct: 30 },
  });
  await section.getByRole('link', { name: '상세 보기' }).click();
  await expect(page.getByRole('columnheader', { name: '고정 전략 OOS' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
