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
const idleBackfill = {
  benchmarkId: null, state: 'IDLE', cursorDate: null, from: null, to: null, error: null,
};

async function restoreWizard(page: Page, step: string): Promise<void> {
  const payloads: Record<string, unknown> = {
    strategy: { strategyId: strategy.id, parameters: {}, currentStep: step },
    period: {
      ...period, benchmarkId: 'KOSPI',
      benchmarkCoverageVerifiedFor: `KOSPI:${period.from}:${period.to}`,
    },
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
  await page.route('**/api/v1/backtests/wizard-draft/*', (route) => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1)!;
    return route.fulfill({ json: { draft: { payload: payloads[key] } } });
  });
  await page.goto(`/backtests/new/${step}`);
  await expect(page).toHaveURL(new RegExp(`/backtests/new/${step}$`));
}

test('난수 비의존 전략의 입력은 비활성화하고 과거 시드 오류는 제출을 막지 않는다', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/benchmarks?**', (route) =>
    route.fulfill({ json: { benchmarkId: 'KOSPI', points: [], covered: true, backfill: idleBackfill } }));
  await restoreWizard(page, 'capital');
  await expect(page.getByLabel('난수 시드')).toBeDisabled();
  await expect(page.getByLabel('난수 시드')).toHaveValue('');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page.getByText('벤치마크 기간 동기화를 확인했습니다.')).toBeVisible();
  await expect(page.getByText('난수 시드는', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/run$/);

  let submittedSeed: unknown;
  await page.route('**/api/v1/backtests', (route) => {
    submittedSeed = route.request().postDataJSON().randomSeed;
    return route.fulfill({ status: 400, json: { error: '제출 값 확인 완료' } });
  });
  await page.getByRole('button', { name: '백테스트 실행', exact: true }).click();
  await expect.poll(() => submittedSeed).toBe(42);
});

test('유니버스에서 복원한 초안도 검토에서 동기화하고 제출 직전에 다시 확인한다', async ({ page }) => {
  await login(page);
  let covered = false;
  let syncing = false;
  let checks = 0;
  let submissions = 0;
  await page.route('**/api/v1/benchmarks**', (route) => {
    if (route.request().method() === 'POST') {
      syncing = true;
      return route.fulfill({ status: 202, json: { ...idleBackfill, benchmarkId: 'KOSPI', ...period, state: 'RUNNING' } });
    }
    checks += 1;
    return route.fulfill({ json: {
      benchmarkId: 'KOSPI', points: [], covered,
      backfill: syncing && !covered
        ? { ...idleBackfill, benchmarkId: 'KOSPI', ...period, state: 'RUNNING' }
        : idleBackfill,
    } });
  });
  await page.route('**/api/v1/backtests', (route) => {
    submissions += 1;
    return route.fulfill({ status: 400, json: { error: '제출되면 안 됩니다' } });
  });
  await restoreWizard(page, 'universe');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/capital$/);
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/review$/);
  await expect(page.getByText('벤치마크 기간 데이터가 부족합니다. 동기화한 뒤 진행하세요.')).toBeVisible();
  expect(checks).toBeGreaterThan(0);
  await page.getByRole('button', { name: '동기화', exact: true }).click();
  await expect(page.getByRole('button', { name: '동기화 중…', exact: true })).toBeDisabled();
  covered = true;
  await expect(page.getByRole('button', { name: '다음', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page).toHaveURL(/\/backtests\/new\/run$/);
  await expect(page.getByRole('button', { name: '백테스트 실행', exact: true })).toBeEnabled();
  covered = false;
  syncing = false;
  const beforeSubmitChecks = checks;
  await page.getByRole('button', { name: '백테스트 실행', exact: true }).click();
  await expect(page.getByRole('button', { name: '동기화', exact: true })).toBeVisible();
  expect(checks).toBeGreaterThan(beforeSubmitChecks);
  expect(submissions).toBe(0);
  await expect(page).toHaveURL(/\/backtests\/new\/run$/);
});

test('실행 단계로 복원해도 벤치마크 조회 오류를 재확인하기 전에는 제출하지 않는다', async ({ page }) => {
  await login(page);
  let failed = true;
  let submissions = 0;
  await page.route('**/api/v1/benchmarks?**', (route) => failed
    ? route.fulfill({ status: 503, json: { error: '일시적인 조회 실패' } })
    : route.fulfill({ json: { benchmarkId: 'KOSPI', points: [], covered: true, backfill: idleBackfill } }));
  await page.route('**/api/v1/backtests', (route) => {
    submissions += 1;
    return route.fulfill({ status: 400, json: { error: '확인 후 제출됨' } });
  });
  await restoreWizard(page, 'run');
  const retry = page.getByRole('button', { name: '다시 확인', exact: true });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('alert').filter({ hasText: '일시적인 조회 실패' })).toBeVisible();
  expect(submissions).toBe(0);
  failed = false;
  await retry.click();
  await expect.poll(() => submissions).toBe(1);
});

for (const step of ['period', 'review', 'run']) {
  test(`${step}에서 벤치마크 수집 실패를 표시하고 명시적으로 재시도한다`, async ({ page }) => {
    await login(page);
    let state = 'IDLE';
    let attempts = 0;
    const error = 'PENDING_PUBLICATION: fixture (KRX_EMPTY_PENDING:빈 응답)';
    await page.route('**/api/v1/benchmarks**', (route) => {
      if (route.request().method() === 'POST') {
        attempts += 1;
        state = 'RUNNING';
        return route.fulfill({ status: 202, json: {
          ...idleBackfill, benchmarkId: 'KOSPI', ...period, state, cursorDate: period.from,
        } });
      }
      return route.fulfill({ json: {
        benchmarkId: 'KOSPI', points: [], covered: false,
        backfill: { ...idleBackfill, benchmarkId: 'KOSPI', ...period, state,
          cursorDate: period.from, error: state === 'FAILED' ? error : null },
      } });
    });
    await restoreWizard(page, step);
    if (step === 'period') await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByRole('button', { name: '동기화', exact: true }).click();
    await expect(page.getByRole('button', { name: '동기화 중…', exact: true })).toBeDisabled();
    state = 'FAILED';
    const failure = page.getByRole('alert').filter({ hasText: '벤치마크 동기화에 실패했습니다' });
    await expect(failure).toContainText(error);
    await expect(failure).toContainText(period.from);
    await expect(page.getByRole('button', { name: '동기화 중…', exact: true })).toHaveCount(0);
    const retry = page.getByRole('button', { name: '동기화 다시 시도', exact: true });
    await expect(retry).toBeEnabled();
    expect(attempts).toBe(1);
    await retry.click();
    await expect.poll(() => attempts).toBe(2);
    await expect(failure).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/backtests/new/${step}$`));
  });
}

test('수집 중 화면을 나갔다 돌아와도 저장된 RUNNING을 재조회해 실패를 표시한다', async ({ page }) => {
  await login(page);
  let state = 'IDLE';
  await page.route('**/api/v1/benchmarks**', (route) => {
    if (route.request().method() === 'POST') {
      state = 'RUNNING';
      return route.fulfill({ status: 202, json: {
        ...idleBackfill, benchmarkId: 'KOSPI', ...period, state,
      } });
    }
    return route.fulfill({ json: {
      benchmarkId: 'KOSPI', points: [], covered: false,
      backfill: { ...idleBackfill, benchmarkId: 'KOSPI', ...period, state,
        cursorDate: period.from, error: state === 'FAILED' ? 'KRX 응답 없음' : null },
    } });
  });
  await restoreWizard(page, 'period');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.getByRole('button', { name: '동기화', exact: true }).click();
  await expect(page.getByRole('button', { name: '동기화 중…', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: '대시보드', exact: true }).click();
  state = 'FAILED';
  await page.goBack();
  await expect(page).toHaveURL(/\/backtests\/new\/period$/);
  await expect(page.getByRole('alert').filter({ hasText: 'KRX 응답 없음' })).toBeVisible();
  await expect(page.getByRole('button', { name: '동기화 다시 시도', exact: true })).toBeEnabled();
});

test('서버가 기존 수집 작업을 반환해도 기다리던 작업의 오류를 숨기지 않는다', async ({ page }) => {
  await login(page);
  let state = 'IDLE';
  const otherJob = { benchmarkId: 'KOSDAQ', from: '2026-04-01', to: '2026-04-02', cursorDate: '2026-04-02' };
  await page.route('**/api/v1/benchmarks**', (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ benchmarkId: 'KOSPI', ...period });
      state = 'RUNNING';
      return route.fulfill({ status: 202, json: { ...idleBackfill, ...otherJob, state } });
    }
    return route.fulfill({ json: {
      benchmarkId: 'KOSPI', points: [], covered: false,
      backfill: { ...idleBackfill, ...otherJob, state, error: state === 'FAILED' ? 'KRX_HTTP_503' : null },
    } });
  });
  await restoreWizard(page, 'review');
  await page.getByRole('button', { name: '동기화', exact: true }).click();
  await expect(page.getByRole('button', { name: '동기화 중…', exact: true })).toBeDisabled();
  state = 'FAILED';
  const failure = page.getByRole('alert').filter({ hasText: 'KRX_HTTP_503' });
  await expect(failure).toContainText('코스닥');
  await expect(failure).toContainText(otherJob.cursorDate);
  await expect(page.getByRole('button', { name: '동기화 다시 시도', exact: true })).toBeEnabled();
});
