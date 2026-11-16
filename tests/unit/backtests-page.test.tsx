import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import * as tablePreferences from '../../src/web/features/backtests/history-table-preferences.js';
import { TooltipProvider } from '../../src/web/components/ui/tooltip.js';
import {
  BacktestsPage,
  BacktestJobCard,
  deletableBacktestIds,
  toggleAllBacktests,
} from '../../src/web/features/backtests/backtests-page.js';
import type {
  BacktestMetrics,
  JobSummary,
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

    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain('CAGR +12.34%');
    expect(html).toContain('매도 체결 3건');
    expect(html).not.toContain('/seeds');
    expect(html).not.toContain('/validations');
  });

  it('실행 대기 상세와 종목 단위를 표시하고 미확정 분모에서 막대 진행률을 쓰지 않는다', () => {
    const waitingJob: JobSummary = {
      ...job('waiting', 'RUNNING'),
      progressBars: 50,
      totalBars: 100,
      progress: {
        activity: 'WAITING_FOR_CAPACITY', detail: '필요 2,048 MiB · 사용 가능 768 MiB',
        actorKind: 'SERVER', actorId: null, actorName: '운영 서버', unit: 'SYMBOLS',
        completed: 5, total: null, currentItem: null, attempt: null, retryCount: 0,
        startedAtMs: 1, lastProgressAtMs: 2, lastReceivedAtMs: 2, nextResumeAtMs: null,
      },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <BacktestJobCard
          job={waitingJob}
          timeframe="1d"
          editing={false}
          selected={false}
          onToggle={() => {}}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('작업 용량 대기');
    expect(html).toContain('필요 2,048 MiB · 사용 가능 768 MiB');
    expect(html).not.toContain('50%');
    expect(html).not.toContain('role="progressbar"');
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

  it('목록에서 원본과 기록된 실험 화면으로 이동한다', () => {
    const source = job('source', 'COMPLETED');
    const client = new QueryClient();
    client.setQueryData(['backtests', 'groups'], { groups: [{ strategyId: source.strategyId, total: 1 }] });
    client.setQueryData(['backtests', 'history', 'strategyId=range-breakout&sort=createdAt&dir=desc&limit=6&offset=0'], { jobs: [source], total: 1 });
    client.setQueryData(['backtest-experiments', 'summaries', ['source']], {
      summaries: [{ jobId: 'source', seed: { batchCount: 1 }, validation: { experimentCount: 1 } }],
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
        <TooltipProvider>
          <MemoryRouter>
            <BacktestsPage />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('href="/backtests/source"');
    expect(html).toContain('href="/backtests/source/seeds"');
    expect(html).toContain('href="/backtests/source/validations"');
    expect(html).not.toContain('/backtests/batches/');
  });

  it('표에서 실험 건수와 유효한 수익률의 표준편차를 표시한다', () => {
    const source = job('source', 'COMPLETED');
    const client = new QueryClient();
    client.setQueryData(['backtests', 'groups'], { groups: [{ strategyId: source.strategyId, total: 1 }] });
    client.setQueryData(['backtests', 'history', 'strategyId=range-breakout&sort=createdAt&dir=desc&limit=10&offset=0'], { jobs: [source], total: 1 });
    client.setQueryData(['backtest-experiments', 'summaries', ['source']], {
      summaries: [{ jobId: 'source', benchmarkExcessReturnPct: 3, seed: { batchCount: 2, activeCount: 0, completedCount: 1, returns: { count: 5, mean: 10, sampleStdDev: 1.25 } }, validation: { experimentCount: 1, activeCount: 0, completedCount: 1, returns: { count: 1, mean: 4, sampleStdDev: null }, modes: {} } }],
    });
    const preference = vi.spyOn(tablePreferences, 'useHistoryTablePreferences').mockReturnValue({
      order: [...tablePreferences.DEFAULT_HISTORY_TABLE_PREFERENCES.order],
      visible: ['seed', 'validation'],
      visibleColumns: tablePreferences.HISTORY_TABLE_COLUMNS.filter((column) => column.id === 'seed' || column.id === 'validation'),
      setVisible: () => {},
      setOrder: () => {},
    });
    try {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}><TooltipProvider><MemoryRouter initialEntries={['/backtests?view=table']}><BacktestsPage /></MemoryRouter></TooltipProvider></QueryClientProvider>,
      );
      expect(html).toContain('2 (1.25%p)');
      expect(html).toContain('1 (—)');
      expect(html).not.toContain('초과수익률');
      expect(html).not.toContain('+3.00%');
    } finally {
      preference.mockRestore();
    }
  });

});
