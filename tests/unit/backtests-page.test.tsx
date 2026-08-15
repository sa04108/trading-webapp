import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  BacktestsPage,
  BacktestJobCard,
  SeedCloneBatchCard,
  deletableBacktestIds,
  groupSeedBatchesBySource,
  hasActiveSeedBatch,
  toggleAllBacktests,
} from '../../src/web/features/backtests/backtests-page.js';
import type {
  BacktestMetrics,
  JobSummary,
  SeedCloneBatchSummary,
} from '../../src/web/features/backtests/types.js';

const metrics: BacktestMetrics = {
  initialCash: 10_000_000,
  finalEquity: 12_000_000,
  totalReturnPct: 20,
  cagrPct: 12.34,
  maxDrawdownPct: -5,
  maxDrawdownDurationMs: 0,
  volatilityPct: null,
  sharpe: null,
  sortino: null,
  calmar: null,
  winRate: null,
  profitFactor: null,
  avgWin: null,
  avgLoss: null,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
  tradeCount: 3,
  avgHoldingTimeMs: null,
  maxConcurrentPositions: 1,
  totalCommission: 0,
  totalTax: 0,
  totalSlippage: 0,
};

function job(id: string, status: JobSummary['status']): JobSummary {
  return {
    id,
    status,
    strategyId: 'range-breakout',
    request: {
      strategyId: 'range-breakout',
      parameters: {},
      universeRule: {
        markets: ['KOSPI'],
        stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 10 }],
        rebalanceInterval: { value: 1, unit: 'MONTH' },
      },
      period: { from: '2025-01-01', to: '2026-01-01' },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
      },
      risk: { maxPositions: 5 },
      randomSeed: 42,
    },
    progressBars: null,
    totalBars: null,
    progressLabel: null,
    error: null,
    createdAtMs: Date.UTC(2026, 0, 2),
    startedAtMs: null,
    completedAtMs: status === 'COMPLETED' ? Date.UTC(2026, 0, 2) : null,
    cloneBatchId: null,
    cloneSourceJobId: null,
    metrics: status === 'COMPLETED' ? metrics : null,
  };
}

function batch(
  id: string,
  sourceJobId: string,
  status: SeedCloneBatchSummary['status'] = 'COMPLETED',
): SeedCloneBatchSummary {
  return {
    id,
    sourceJobId,
    strategyId: 'range-breakout',
    status,
    totalCount: 3,
    pendingCount: status === 'ACTIVE' ? 2 : 0,
    queuedCount: 0,
    runningCount: status === 'ACTIVE' ? 1 : 0,
    completedCount: status === 'COMPLETED' ? 3 : 0,
    failedCount: 0,
    cancelledCount: 0,
    interruptedCount: 0,
    deletedCount: 0,
    request: job(sourceJobId, 'COMPLETED').request,
    error: null,
    createdAtMs: Date.UTC(2026, 0, 3),
    completedAtMs: status === 'COMPLETED' ? Date.UTC(2026, 0, 3) : null,
  };
}

describe('백테스트 목록', () => {
  it('완료 항목에 CAGR을 표시한다', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <BacktestJobCard
          job={job('completed', 'COMPLETED')}
          timeframe="1d"
          editing={false}
          selected={false}
          onToggle={() => {}}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('CAGR +12.34%');
  });

  it('편집 시 종료된 항목만 전체 선택하고, 다시 누르면 선택을 해제한다', () => {
    const ids = deletableBacktestIds([
      job('completed', 'COMPLETED'),
      job('failed', 'FAILED'),
      job('running', 'RUNNING'),
    ]);

    expect(ids).toEqual(['completed', 'failed']);
    expect([...toggleAllBacktests(new Set(), ids)]).toEqual(ids);
    expect(toggleAllBacktests(new Set(ids), ids).size).toBe(0);
  });

  it('난수 실험을 원본 ID별로 묶고 실행 중인 실험이 있으면 원본 삭제를 막는다', () => {
    const grouped = groupSeedBatchesBySource([
      batch('batch-a', 'source-a'),
      batch('batch-b', 'source-b'),
      batch('batch-c', 'source-a', 'ACTIVE'),
    ]);

    expect(grouped.get('source-a')?.map(({ id }) => id)).toEqual(['batch-a', 'batch-c']);
    expect(grouped.get('source-b')?.map(({ id }) => id)).toEqual(['batch-b']);
    expect(hasActiveSeedBatch(grouped.get('source-a') ?? [])).toBe(true);
    expect(hasActiveSeedBatch(grouped.get('source-b') ?? [])).toBe(false);
  });

  it('편집 중 종료된 난수 실험에는 단독 삭제를 제공하고 실행 중이면 비활성화한다', () => {
    const completedHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SeedCloneBatchCard batch={batch('done', 'source')} editing onRemove={() => {}} />
      </MemoryRouter>,
    );
    const activeHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SeedCloneBatchCard batch={batch('active', 'source', 'ACTIVE')} editing onRemove={() => {}} />
      </MemoryRouter>,
    );

    expect(completedHtml).toContain('실험 삭제');
    expect(completedHtml).not.toContain('disabled=""');
    expect(activeHtml).toContain('실험 삭제');
    expect(activeHtml).toContain('disabled=""');
  });

  it('목록에서 난수 실험을 별도 섹션 대신 원본 백테스트 카드 바로 아래에 둔다', () => {
    const source = job('source', 'COMPLETED');
    const childBatch = batch('seed-batch', source.id);
    const client = new QueryClient();
    client.setQueryData(['backtests'], { jobs: [] });
    client.setQueryData(['backtest-clone-batches'], {
      batches: [childBatch],
      sourceJobs: [source],
    });
    client.setQueryData(['strategies'], {
      strategies: [{
        id: source.strategyId,
        version: '1.0.0',
        name: 'Range Breakout',
        description: '',
      }],
    });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BacktestsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const sourceLink = html.indexOf('href="/backtests/source"');
    const batchLink = html.indexOf('href="/backtests/batches/seed-batch"');
    expect(sourceLink).toBeGreaterThanOrEqual(0);
    expect(batchLink).toBeGreaterThan(sourceLink);
    expect(html).toContain('border-l-2');
    expect(html).not.toContain('>난수 시드 실험</h3>');
  });
});
