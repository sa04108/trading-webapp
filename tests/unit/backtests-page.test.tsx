import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  BacktestJobCard,
  deletableBacktestIds,
  toggleAllBacktests,
} from '../../src/web/features/backtests/backtests-page.js';
import type { BacktestMetrics, JobSummary } from '../../src/web/features/backtests/types.js';

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
});
