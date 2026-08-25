import { describe, expect, it } from 'vitest';
import {
  buildFinancialExecutionWindows,
  financialFactCutoffsFromCandles,
} from '../../src/server/modules/backtest/application/backtest-financial-execution-window.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';

const midnight = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const period = { from: '2025-01-01', to: '2025-01-10' } as const;

function candle(symbol: string, date: string): Candle {
  return {
    symbol,
    market: 'KR',
    venue: 'KOSPI',
    timeframe: '1d',
    tsMs: midnight(date),
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1,
  };
}

describe('financial execution window', () => {
  it('첫 일정은 기간 시작부터 활성이고 편출 뒤 봉은 실행 창에서 제외한다', () => {
    const windows = buildFinancialExecutionWindows({
      period,
      schedule: [
        { rebalanceDate: '2025-01-03', symbols: ['A'] },
        { rebalanceDate: '2025-01-06', symbols: ['B'] },
      ],
    });

    expect(windows).toEqual(new Map([
      ['A', [{ fromTsMs: midnight('2025-01-01'), toTsMs: midnight('2025-01-06') - 1 }]],
      ['B', [{ fromTsMs: midnight('2025-01-06'), toTsMs: midnight('2025-01-10') }]],
    ]));
    expect(financialFactCutoffsFromCandles({
      period,
      schedule: [
        { rebalanceDate: '2025-01-03', symbols: ['A'] },
        { rebalanceDate: '2025-01-06', symbols: ['B'] },
      ],
      candles: [
        candle('A', '2025-01-05'),
        candle('A', '2025-01-09'),
        candle('B', '2025-01-07'),
      ],
    })).toEqual(new Map([
      ['A', midnight('2025-01-05')],
      ['B', midnight('2025-01-07')],
    ]));
  });

  it('인접한 동일 멤버십 창은 합치고 최초 상장폐지 직전까지만 허용한다', () => {
    const windows = buildFinancialExecutionWindows({
      period,
      schedule: [
        { rebalanceDate: '2025-01-01', symbols: ['A'] },
        { rebalanceDate: '2025-01-03', symbols: ['A'] },
        { rebalanceDate: '2025-01-08', symbols: ['A'] },
      ],
      delistedTsMsBySymbol: new Map([
        ['A', [midnight('2025-01-07'), midnight('2025-01-09')]],
      ]),
    });

    expect(windows).toEqual(new Map([
      ['A', [{ fromTsMs: midnight('2025-01-01'), toTsMs: midnight('2025-01-07') - 1 }]],
    ]));
    expect(financialFactCutoffsFromCandles({
      period,
      schedule: [{ rebalanceDate: '2025-01-01', symbols: ['A'] }],
      delistedTsMsBySymbol: new Map([['A', [midnight('2025-01-07')]]]),
      candles: [candle('A', '2025-01-06'), candle('A', '2025-01-08')],
    })).toEqual(new Map([['A', midnight('2025-01-06')]]));
  });
});
