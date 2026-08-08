import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 4, 12);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function bar(symbol: string, index: number, close = 1_000): Candle {
  return {
    symbol, market: 'KR', timeframe: '1d', tsMs: START + index * DAY,
    open: close, high: close + 10, low: close - 10, close, volume: 100,
  };
}

/** 첫 봉에서 대상 종목을 한 번 매수하려 드는 전략 */
function buyOnceStrategy(target: string): TradingStrategy<unknown, { done: boolean }> {
  return {
    id: 'buy-once', version: '1', name: 'buy once', description: '',
    parameterSchema: z.object({}).passthrough(),
    initialize: () => ({ done: false }),
    onBars: (_context, state) => {
      if (state.done) return { orders: [] };
      state.done = true;
      return { orders: [{ symbol: target, side: 'BUY' as const, quantity: 1 }] };
    },
  };
}

describe('엔진 거래불가일', () => {
  it('거래불가 종목의 매수를 거부한다', () => {
    const candles = [bar('A', 0), bar('A', 1), bar('B', 0), bar('B', 1)];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      // 0번 봉 시점에 A 가 거래불가다 — 주문은 그 시점에 발행되고 검증에서 걸려야 한다
      nonTradingSymbolsByTsMs: new Map([[START, new Set(['A'])]]),
    });

    expect(result.fills).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.includes('A 매수 거부'))).toBe(true);
  });

  it('거래불가 종목이 없으면 그대로 매수한다', () => {
    const candles = [bar('A', 0), bar('A', 1)];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(result.fills).toHaveLength(1);
  });
});
