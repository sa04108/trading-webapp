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

describe('상장폐지 청산', () => {
  it('마지막 거래 가능 봉 종가로 청산하고 사유를 남긴다', () => {
    // A 는 2번 봉이 마지막이고 그 뒤 폐지된다. B 는 끝까지 산다.
    // 2번 봉은 시가(600)와 종가(500)를 일부러 다르게 둔다 — bar() 헬퍼의 기본값(open ===
    // close)을 그대로 쓰면 청산가가 시가로 퇴행해도 값이 우연히 같아 테스트가 못 잡는다.
    // high/low 는 시가·종가를 모두 포함하도록 맞춘다.
    const candles = [
      bar('A', 0, 1_000), bar('A', 1, 900),
      { ...bar('A', 2, 500), open: 600, high: 610 },
      bar('B', 0), bar('B', 1), bar('B', 2), bar('B', 3),
    ];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', START + 3 * DAY]]),
    });

    const trade = result.trades.find((candidate) => candidate.symbol === 'A');
    expect(trade).toBeDefined();
    expect(trade?.exitReason).toBe('DELISTED');
    // 2번 봉 종가 500 으로 나간다 — 시가(600)가 아니다
    expect(trade?.exitPrice).toBe(500);
    expect(trade?.exitPrice).not.toBe(600);
    expect(trade?.exitTsMs).toBe(START + 2 * DAY);
    expect(result.delistingLiquidations).toHaveLength(1);
    // 청산했으니 미청산으로 남지 않는다
    expect(result.openPositions.some((position) => position.symbol === 'A')).toBe(false);
  });

  it('폐지 정보가 없으면 미청산으로 남는다', () => {
    const candles = [bar('A', 0, 1_000), bar('A', 1, 900), bar('A', 2, 500), bar('B', 3)];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(result.trades).toHaveLength(0);
    const open = result.openPositions.find((position) => position.symbol === 'A');
    expect(open?.lastPriceTsMs).toBe(START + 2 * DAY);
  });

  it('청산 시점에 onForcedExit 를 부른다', () => {
    const seen: string[] = [];
    const strategy = buyOnceStrategy('A');
    const withHook: TradingStrategy<unknown, { done: boolean }> = {
      ...strategy,
      onForcedExit: (symbol) => { seen.push(symbol); },
    };
    runBacktest(withHook, {
      candles: [bar('A', 0), bar('A', 1), bar('B', 2)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', START + 2 * DAY]]),
    });
    expect(seen).toEqual(['A']);
  });

  it('포지션 없는 종목에는 onForcedExit 를 부르지 않는다', () => {
    const seen: string[] = [];
    const strategy = buyOnceStrategy('A');
    const withHook: TradingStrategy<unknown, { done: boolean }> = {
      ...strategy,
      onForcedExit: (symbol) => { seen.push(symbol); },
    };
    // C 는 폐지 대상이지만 전략이 A 만 사서 C 는 한 번도 보유하지 않는다 —
    // 없는 포지션을 지우려 드는 회귀를 잡는다
    const result = runBacktest(withHook, {
      candles: [bar('A', 0), bar('A', 1), bar('C', 0), bar('C', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['C', START + 1 * DAY]]),
    });
    expect(seen).not.toContain('C');
    expect(result.delistingLiquidations).toHaveLength(0);
  });

  it('폐지 종목의 마지막 봉에서 낸 매수 주문은 체결되지 않고 포지션도 남기지 않는다', () => {
    // D 는 한 봉뿐이고 그 봉이 곧 마지막 봉이다. 전략은 그 봉에서 D 를 매수하려 든다.
    // 다음 봉이 다시 오지 않으니 이 주문은 영원히 체결될 수 없다 — 대기 주문 정리가
    // 포지션 유무와 무관하게 도는지 검증한다(포지션은 애초에 생긴 적이 없다).
    const seen: string[] = [];
    const strategy = buyOnceStrategy('D');
    const withHook: TradingStrategy<unknown, { done: boolean }> = {
      ...strategy,
      onForcedExit: (symbol) => { seen.push(symbol); },
    };
    const result = runBacktest(withHook, {
      candles: [bar('D', 0)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['D', START]]),
    });

    expect(result.fills).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
    expect(result.delistingLiquidations).toHaveLength(0);
    expect(result.openPositions.some((position) => position.symbol === 'D')).toBe(false);
    // 포지션이 생긴 적 없으니 강제 청산 훅도 불리지 않는다
    expect(seen).not.toContain('D');
  });
});
