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

/** 매 봉마다 대상 종목을 매수하려 드는 전략 — 거래불가 필터가 다음 봉으로 새는지 검증하는 용도 */
function buyEveryBarStrategy(target: string): TradingStrategy<unknown, null> {
  return {
    id: 'buy-every-bar', version: '1', name: 'buy every bar', description: '',
    parameterSchema: z.object({}).passthrough(),
    initialize: () => null,
    onBars: () => ({ orders: [{ symbol: target, side: 'BUY' as const, quantity: 1 }] }),
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

  it('거래불가는 그 봉에만 걸리고 다음 봉으로 새지 않는다', () => {
    // 멤버십 일정이 없는 경로(제한 없음 = null)에서만 새는 버그가 난다.
    // 0번 봉에서만 A 를 거래불가로 두고, 1번 봉 주문까지 막히면 필터가 샌 것이다.
    const candles = [bar('A', 0), bar('A', 1), bar('A', 2)];
    const result = runBacktest(buyEveryBarStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      nonTradingSymbolsByTsMs: new Map([[START, new Set(['A'])]]),
    });

    // 0번 봉 주문은 거부된다. 1번 봉 주문은 막히지 않아 2번 봉 시가에서 체결된다.
    // tsMs 를 못박아, 필터가 새서 0번 봉 주문이 (1번 봉 시가에) 체결된 경우와 구별한다.
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.tsMs).toBe(START + 2 * DAY);
  });
});
