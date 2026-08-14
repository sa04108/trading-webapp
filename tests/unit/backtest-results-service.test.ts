import { describe, expect, it } from 'vitest';
import { backtestTrades } from '../../src/server/shared/db/schema.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { createTestApp } from '../helpers/test-app.js';

const REQUEST: BacktestRequest = {
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
};

describe('ResultsService.getChartSeries', () => {
  it('차트 API용 종목 목록은 거래 내역에서 중복 없이 조회한다', async () => {
    const context = await createTestApp();
    try {
      const job = context.container.jobQueue.enqueue(REQUEST);
      context.container.database.db.insert(backtestTrades).values([
        trade(job.id, '005930', 1),
        trade(job.id, '000660', 2),
        trade(job.id, '005930', 3),
      ]).run();

      expect(context.container.resultsService.getChartSeries(job.id).symbols).toEqual([
        '000660',
        '005930',
      ]);
    } finally {
      await context.close();
    }
  });
});

function trade(jobId: string, symbol: string, exitTsMs: number) {
  return {
    jobId,
    symbol,
    quantity: 1,
    entryTsMs: 0,
    exitTsMs,
    entryPrice: 100,
    exitPrice: 110,
    grossPnl: 10,
    costs: 0,
    netPnl: 10,
    returnPct: 10,
    holdingTimeMs: exitTsMs,
    exitReason: null,
  };
}
