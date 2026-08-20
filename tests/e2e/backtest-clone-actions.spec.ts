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
  const randomClone = group.getByRole('button', { name: '새 난수로 복제' });
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
