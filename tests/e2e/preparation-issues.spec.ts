import { expect, test, type Page } from '@playwright/test';
import { advanceFromPeriod } from './backtest-wizard';
import { login } from './login';

const PRICE_WARNING = (symbol: string, period: string) =>
  `KRX 가격 정보를 온전히 확보할 수 없어 종목 ${symbol}을 매매 대상에서 제외했습니다 — `
    + `${period}: DECLINE 계산에 필요한 20개 거래일 일봉 부족.`;

const PREPARATION_WARNINGS = [
  'KRX 가격 정보를 온전히 확보할 수 없어 종목 000001을 매매 대상에서 제외했습니다 — '
    + '2026-01-05: DECLINE 계산에 필요한 20개 거래일 일봉 부족; '
    + '2026-02-05: DECLINE 계산에 필요한 20개 거래일 일봉 부족.',
  ...Array.from({ length: 12 }, (_, index) => (
    PRICE_WARNING(String(index + 2).padStart(6, '0'), '2026-01-05')
  )),
  'KRX 가격 정보를 온전히 확보할 수 없어 종목 000001을 매매 대상에서 제외했습니다 — '
    + '2026-03-05: 활성 기간의 KRX 일봉 3건 누락.',
  '자본변동 정보를 온전히 확보할 수 없어 종목 000001을 매매 대상에서 제외했습니다 — '
    + '2026: corp_code 매핑이 없습니다.',
] as const;

async function mockCoveredBenchmark(page: Page): Promise<void> {
  await page.route('**/api/v1/benchmarks?**', (route) => route.fulfill({
    json: {
      benchmarkId: 'KOSPI',
      points: [
        { date: '2026-01-05', close: 2_500 },
        { date: '2026-03-31', close: 2_600 },
      ],
      covered: true,
      backfill: {
        benchmarkId: null,
        state: 'IDLE',
        cursorDate: null,
        from: null,
        to: null,
        error: null,
      },
    },
  }));
}

async function openPreparedUniverse(page: Page): Promise<void> {
  await mockCoveredBenchmark(page);
  await page.route('**/api/v1/backtests/universe-preview', (route) => route.fulfill({
    json: {
      preparationJobId: 'prep_e2e_issues',
      schedule: [{
        rebalanceDate: '2026-01-05',
        effectiveDate: '2026-01-05',
        members: [{ symbol: '005930' }],
      }],
      unionSymbols: ['005930'],
      fundamentalSymbols: [],
      scheduleHash: 'preparation-issues-e2e',
      uncoveredDates: [],
      periodCovered: true,
      missingCandleSymbols: [],
      warnings: PREPARATION_WARNINGS,
    },
  }));

  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.getByLabel('시작일').fill('2026-01-05');
  await page.getByLabel('종료일').fill('2026-03-31');
  await advanceFromPeriod(page);
  await page.getByRole('button', { name: '미리보기', exact: true }).click();
  await expect(page.getByRole('table', { name: '유니버스 준비 확인사항 요약' }))
    .toBeVisible();
}

test('준비 확인사항은 요약에서 코드를 숨기고 상세 두 보기에서 모든 행을 제공한다', async ({
  page,
}, testInfo) => {
  await login(page);
  await openPreparedUniverse(page);

  const card = page.locator('[data-slot="card"]').filter({
    has: page.getByText('유니버스 준비 확인사항', { exact: true }),
  });
  const summary = card.getByRole('table', { name: '유니버스 준비 확인사항 요약' });
  await expect(summary.getByRole('columnheader').last()).toHaveText('종목 수');
  const shortageRow = summary.getByRole('row').filter({
    hasText: '계산에 필요한 거래일 일봉 부족',
  });
  await expect(shortageRow.getByRole('cell').last()).toHaveText('13');
  await expect(card).toContainText('중복 제외 13종목');
  await expect(card).not.toContainText('000001');

  const detailsTrigger = card.getByRole('button', { name: '자세히 보기' });
  await expect(card.getByRole('button', { name: '자세히 보기' })).toHaveCount(1);
  await detailsTrigger.click();

  const dialog = page.getByRole('dialog', { name: '유니버스 준비 확인사항 상세' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('tab', { name: '기본보기' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const basic = dialog.getByRole('table', { name: '확인사항 기본보기' });
  await expect(basic).toBeVisible();
  await expect(basic.getByRole('columnheader').first()).toHaveText('API / 데이터');
  await expect(basic.getByRole('row')).toHaveCount(16);
  await expect(basic.getByRole('cell', { name: 'KRX · 일봉', exact: true }))
    .toHaveAttribute('rowspan', '14');
  await expect(basic.getByRole('cell', {
    name: /계산에 필요한 거래일 일봉 부족/,
  })).toHaveAttribute('rowspan', '13');
  for (let code = 1; code <= 13; code += 1) {
    await expect(basic.getByText(String(code).padStart(6, '0'), { exact: true }))
      .toHaveCount(code === 1 ? 3 : 1);
  }
  await page.screenshot({ path: testInfo.outputPath('preparation-issues-basic.png') });
  const lastBasicRow = basic.getByRole('row').last();
  await lastBasicRow.scrollIntoViewIfNeeded();
  await expect(lastBasicRow).toBeVisible();
  const basicIssueRows = await basic.locator('tbody tr').evaluateAll((rows) => rows.map((row) => (
    [...row.querySelectorAll('td')]
      .slice(-2)
      .map((cell) => cell.textContent?.trim() ?? '')
      .join('|')
  )).sort());

  const viewport = page.viewportSize();
  const dialogBox = await dialog.boundingBox();
  if (viewport === null || dialogBox === null) {
    throw new Error('상세 대화상자와 viewport 크기를 측정할 수 없습니다.');
  }
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(0);

  await dialog.getByRole('tab', { name: '종목별보기' }).click();
  const bySymbol = dialog.getByRole('table', { name: '확인사항 종목별보기' });
  await expect(bySymbol).toBeVisible();
  await expect(bySymbol.getByRole('columnheader').first()).toHaveText('종목코드');
  await expect(bySymbol.getByRole('row')).toHaveCount(16);
  const mergedSymbol = bySymbol.getByRole('cell', { name: '000001', exact: true });
  await expect(mergedSymbol).toHaveCount(1);
  await expect(mergedSymbol).toHaveAttribute('rowspan', '3');
  const symbolIssueRows = await bySymbol.locator('tbody tr').evaluateAll((rows) => rows.map((row) => (
    [...row.querySelectorAll('td')]
      .slice(-2)
      .map((cell) => cell.textContent?.trim() ?? '')
      .join('|')
  )).sort());
  expect(symbolIssueRows).toEqual(basicIssueRows);
  await page.screenshot({ path: testInfo.outputPath('preparation-issues-symbols.png') });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(detailsTrigger).toBeFocused();
  await detailsTrigger.click();
  await expect(page.getByRole('dialog', {
    name: '유니버스 준비 확인사항 상세',
  }).getByRole('tab', { name: '기본보기' })).toHaveAttribute('aria-selected', 'true');
});

const RESULT_JOB_ID = 'bt_preparation_issues_result';
const GLOBAL_LIMITATION =
  '이 백테스트가 보정하지 않는 것: 배당. 손절·익절은 종가로만 판정합니다.';

test('결과 화면도 준비 확인사항을 분리하고 과거 실행 경고에서 종목 코드를 제거한다', async ({
  page,
}) => {
  await login(page);
  const warnings = [
    ...PREPARATION_WARNINGS,
    '000777 매수 거부: 현금 부족 (2026-01-06T00:00:00.000Z)',
    '000888 매수 거부: 현금 부족 (2026-01-07T00:00:00.000Z)',
    GLOBAL_LIMITATION,
  ];
  await page.route(`**/api/v1/backtests/${RESULT_JOB_ID}`, (route) => route.fulfill({
    json: {
      job: {
        id: RESULT_JOB_ID,
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
          period: { from: '2026-01-05', to: '2026-03-31' },
          capital: { initialCash: 10_000_000, currency: 'KRW' },
          execution: {
            fillTiming: 'NEXT_BAR_OPEN',
            commissionProfileId: 'kr-equity-default',
            slippageProfileId: 'fixed-5bps',
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
        completedAtMs: Date.UTC(2026, 0, 2),
        cloneBatchId: null,
        cloneSourceJobId: null,
      },
      run: {
        strategyId: 'range-breakout',
        strategyVersion: '1.0.0',
        strategySourceHash: 'source-hash',
        parameterJson: '{}',
        universeHash: 'universe-hash',
        universeJson: '[]',
        engineVersion: 'test',
        feeModelVersion: 'kr-equity-default@test',
        slippageModelVersion: 'fixed-5bps@test',
        randomSeed: 42,
        gitCommitSha: 'abcdef1234567890',
        warningsJson: JSON.stringify(warnings),
        openPositionsJson: null,
        startedAtMs: Date.UTC(2026, 0, 1),
        completedAtMs: Date.UTC(2026, 0, 2),
      },
      metrics: null,
      benchmark: null,
      provenancePin: null,
      universeRebalancing: [],
    },
  }));

  await page.goto(`/backtests/${RESULT_JOB_ID}`);
  const preparationSummary = page.getByRole('table', {
    name: '유니버스 준비 확인사항 요약',
  });
  await expect(preparationSummary).toBeVisible();
  await expect(page.getByText('이 백테스트를 준비할 당시 확인된 내용입니다.'))
    .toBeVisible();

  const execution = page.getByRole('region', { name: '실행 중 발생한 경고' });
  await expect(execution).toContainText('현금 부족으로 거부된 매수 주문 2건.');
  await expect(execution).not.toContainText('000777');
  await expect(execution).not.toContainText('000888');
  const limitations = page.getByRole('region', { name: '계산 방식·한계' });
  await expect(limitations).toContainText(GLOBAL_LIMITATION);
});
