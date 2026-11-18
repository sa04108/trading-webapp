import { expect, test } from '@playwright/test';
import { login } from './login';

const JOB_ID = 'bt_clone_actions_layout';

const detail = {
  job: {
    id: JOB_ID,
    status: 'FAILED',
    strategyId: 'range-breakout',
    request: {
      strategyId: 'range-breakout',
      parameters: {},
      universeRule: {
        markets: ['KOSPI'],
        stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 10 }],
        rebalanceInterval: { unit: 'MONTH', value: 1 },
      },
      timeframe: '1d',
      period: { from: '2026-01-01', to: '2026-06-30' },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'close-fixed',
      },
      risk: { maxPositions: 10 },
      randomSeed: 42,
    },
    progressBars: null,
    totalBars: null,
    progressLabel: null,
    error: null,
    createdAtMs: Date.UTC(2026, 0, 1),
    startedAtMs: Date.UTC(2026, 0, 1),
    completedAtMs: Date.UTC(2026, 0, 1),
    cloneBatchId: null,
    cloneSourceJobId: null,
  },
  run: null,
  metrics: null,
  benchmark: null,
  provenancePin: null,
  universeRebalancing: [],
};

test('복제 액션 그룹은 모바일에서 2 + 1 패널로 이어진다', async ({ page }, testInfo) => {
  await login(page);
  await page.route(`**/api/v1/backtests/${JOB_ID}`, (route) =>
    route.fulfill({ json: detail }),
  );
  await page.goto(`/backtests/${JOB_ID}`);

  const group = page.getByRole('group', { name: '백테스트 복제' });
  const sameClone = group.getByRole('button', { name: '그대로 복제' });
  const randomClone = group.getByRole('link', { name: '설정 탐색 실험' });
  const resetClone = group.getByRole('link', { name: '재설정 및 복제' });
  await expect(group).toBeVisible();

  const [groupBox, sameBox, randomBox, resetBox] = await Promise.all([
    group.boundingBox(),
    sameClone.boundingBox(),
    randomClone.boundingBox(),
    resetClone.boundingBox(),
  ]);
  if (!groupBox || !sameBox || !randomBox || !resetBox) {
    throw new Error('복제 액션 그룹의 배치를 측정할 수 없습니다.');
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(Math.abs(sameBox.y - randomBox.y)).toBeLessThanOrEqual(1);

  if (testInfo.project.name === 'mobile') {
    expect(resetBox.y).toBeGreaterThan(sameBox.y);
    expect(Math.abs(resetBox.x - groupBox.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(resetBox.width - groupBox.width)).toBeLessThanOrEqual(2);
    await expect(randomClone).toHaveCSS('border-left-width', '1px');
    await expect(resetClone).toHaveCSS('border-top-width', '1px');
  } else {
    expect(Math.abs(sameBox.y - resetBox.y)).toBeLessThanOrEqual(1);
    await expect(resetClone).toHaveCSS('border-left-width', '1px');
    await expect(resetClone).toHaveCSS('border-top-width', '0px');
  }
});

test('난수 비의존 전략도 설정 탐색을 제공하고 재현 정보에서 시드를 숨긴다', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/strategies', (route) => route.fulfill({ json: { strategies: [{
    id: 'range-breakout', version: 'test-version', name: '검증 전략', description: '',
    supportsRandomSeed: false,
  }] } }));
  await page.route(`**/api/v1/backtests/${JOB_ID}`, (route) => route.fulfill({ json: {
    ...detail,
    run: {
      strategyId: 'range-breakout', strategyVersion: 'test-version', strategySourceHash: 'fixture',
      parameterJson: '{}', universeHash: 'fixture', universeJson: '[]', engineVersion: 'test',
      feeModelVersion: 'test', slippageModelVersion: 'test', randomSeed: 42, gitCommitSha: 'fixture',
      warningsJson: null, openPositionsJson: null, startedAtMs: Date.UTC(2026, 0, 1), completedAtMs: Date.UTC(2026, 0, 1),
    },
  } }));
  await page.goto(`/backtests/${JOB_ID}`);
  await expect(page.getByRole('link', { name: '설정 탐색 실험', exact: true })).toHaveAttribute('href', `/backtests/${JOB_ID}/search`);
  await expect(page.getByRole('button', { name: '그대로 복제', exact: true })).toBeEnabled();
  await expect(page.getByText('재현 정보', { exact: true })).toBeVisible();
  await expect(page.getByText('난수 시드', { exact: true })).toHaveCount(0);
});

test('이전 난수 작업의 실패 화면은 재시도 대신 설정 탐색으로 안내한다', async ({ page }) => {
  await login(page);
  await page.route(`**/api/v1/backtests/${JOB_ID}`, route => route.fulfill({ json: detail }));
  await page.route('**/api/v1/backtests/refresh-jobs/*', route => {
    const id = route.request().url().split('/').at(-1)!;
    return route.fulfill({ json: { job: {
      id, sourceJobId: JOB_ID, status: 'FAILED',
      action: id === 'legacy' ? { kind: 'RANDOM_SEEDS', count: 3 } : { kind: 'CLONE' },
      preparationJobId: null, message: '데이터 준비 실패', error: '실행 기준이 변경되었습니다.',
      resultHref: null, createdAtMs: 1, completedAtMs: 2,
    } } });
  });
  await page.goto(`/backtests/${JOB_ID}?refreshJob=legacy`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('이전 난수 복제는 다시 실행할 수 없습니다.');
  await expect(dialog.getByRole('button', { name: '다시 준비 후 실행' })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: '설정 탐색에서 새 실험을 시작하세요.' })).toHaveAttribute('href', `/backtests/${JOB_ID}/search`);

  await page.goto(`/backtests/${JOB_ID}?refreshJob=clone`);
  await expect(dialog.getByRole('button', { name: '다시 준비 후 실행' })).toBeVisible();
  await expect(dialog.getByText('이전 난수 복제는 다시 실행할 수 없습니다.')).toHaveCount(0);
});
