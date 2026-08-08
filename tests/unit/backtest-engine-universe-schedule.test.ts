import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile, OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { StrategyBarContext, TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 6, 6, 0, 0);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function bar(index: number, price: number, overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: 'A',
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * HOUR,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume: 100,
    ...overrides,
  };
}

/**
 * 매 봉 A·B 모두에 1주 매수를 시도하는 전략 — 유니버스 필터가 실제로 걸러내는지
 * 보려면 전략이 스스로 필터링하지 않고 항상 두 종목 모두를 시도해야 한다.
 * 이미 보유 중인 종목은 다시 사지 않는다(중복 매수 방지, 테스트를 단순하게 유지).
 */
function alwaysBuyBothStrategy(): TradingStrategy<unknown, null> {
  return {
    id: 'test-always-buy-both',
    version: '1.0.0',
    name: 'test',
    description: 'test',
    parameterSchema: z.unknown(),
    initialize: () => null,
    onBars(context: StrategyBarContext) {
      const orders: OrderIntent[] = [];
      for (const symbol of ['A', 'B']) {
        if (!context.bars.has(symbol)) continue;
        if ((context.portfolio.positions.get(symbol)?.quantity ?? 0) > 0) continue;
        orders.push({ symbol, side: 'BUY', quantity: 1 });
      }
      return { orders };
    },
  };
}

describe('runBacktest — 멤버십 일정 기반 거래 대상 제한 (스펙 2026-08-05, §9.5)', () => {
  it('1구간에서는 일정에 포함된 A 만 매수되고 B 는 거부된다', () => {
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
    ];
    const result = runBacktest(alwaysBuyBothStrategy() as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['A'] }],
    });

    const filledSymbols = new Set(result.fills.map((f) => f.symbol));
    expect(filledSymbols).toEqual(new Set(['A']));
    expect(result.warnings.some((w) => w.includes('B'))).toBe(true);
  });

  it('2구간 전환 후에는 B 가 매수되고, 보유 중이던 A 는 REBALANCE_EXIT 경로가 아니라 전략 자체 매도로 청산된다', () => {
    // A 는 봉0 신호 → 봉1 체결. 봉2 부터 일정이 B 로 전환된다.
    // 전략이 봉2 에서 A 를 매도하면(보유분 청산은 항상 허용) 봉3 시가에서 체결되고,
    // 그 사이 B 는 일정 전환 이후 봉2 신호 → 봉3 체결로 새로 편입된다.
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(2, 100),
      bar(3, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
      bar(2, 200, { symbol: 'B' }),
      bar(3, 200, { symbol: 'B' }),
    ];

    const buyBFrom2: TradingStrategy<unknown, { seen: number }> = {
      id: 'test-buy-b-from-2',
      version: '1.0.0',
      name: 'test',
      description: 'test',
      parameterSchema: z.unknown(),
      initialize: () => ({ seen: 0 }),
      onBars(context, state) {
        const orders: OrderIntent[] = [];
        // 봉0 에서 A 매수(1구간에서 유효), 봉2 이후 B 매수 시도(2구간 전환 후 유효)
        if (state.seen === 0) orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
        if (state.seen === 2) {
          const heldA = context.portfolio.positions.get('A')?.quantity ?? 0;
          if (heldA > 0) orders.push({ symbol: 'A', side: 'SELL', quantity: heldA });
          // 이 시점부터는 A 가 일정 밖이다 — 청산과 별개로 재매수 의도는 거부돼야 한다
          orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
          orders.push({ symbol: 'B', side: 'BUY', quantity: 1 });
        }
        state.seen += 1;
        return { orders };
      },
    };

    const result = runBacktest(buyBFrom2 as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, symbols: ['A'] },
        { fromTsMs: START + 2 * HOUR, symbols: ['B'] },
      ],
    });

    const aFills = result.fills.filter((f) => f.symbol === 'A');
    const bFills = result.fills.filter((f) => f.symbol === 'B');
    expect(aFills.filter((f) => f.side === 'BUY')).toHaveLength(1); // 1구간 매수 성공, 2구간 재매수는 거부
    expect(aFills.some((f) => f.side === 'SELL')).toBe(true); // 보유분 청산은 유니버스와 무관하게 허용
    expect(bFills.some((f) => f.side === 'BUY')).toBe(true); // 2구간 전환 후 매수 성공
  });

  it('일정 밖 심볼의 BUY 의도는 거부되고 종목당 한 번만 warning 이 쌓인다', () => {
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(2, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
      bar(2, 200, { symbol: 'B' }),
    ];
    const result = runBacktest(alwaysBuyBothStrategy() as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['A'] }],
    });

    // B 는 매 봉마다(세 번) 매수를 시도하지만, 실제로 체결되는 것은 없고
    // 경고는 종목당 한 줄로만 쌓여야 한다(폭주 방지).
    const bFills = result.fills.filter((f) => f.symbol === 'B');
    expect(bFills).toHaveLength(0);
    const bWarnings = result.warnings.filter((w) => w.includes('B') && w.includes('멤버십 일정'));
    expect(bWarnings).toHaveLength(1);
  });

  it('일정이 미지정이면 tradableSymbols 는 null 이고 기존 동작(제한 없음)과 동일하다', () => {
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
    ];
    const result = runBacktest(alwaysBuyBothStrategy() as never, {
      candles,
      initialCash: 100_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      // universeSchedule 미지정
    });

    const filledSymbols = new Set(result.fills.map((f) => f.symbol));
    expect(filledSymbols).toEqual(new Set(['A', 'B']));
  });

  it('첫 리밸런스 이전 시점에도 첫 entry 를 적용한다 (방어적 단순화)', () => {
    // 일정의 첫 entry 가 봉1 부터 시작해도, 봉0(그 이전) 에서도 같은 유니버스가 적용된다.
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
    ];
    const result = runBacktest(alwaysBuyBothStrategy() as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START + HOUR, symbols: ['A'] }], // 봉1 시각부터 유효
    });

    const filledSymbols = new Set(result.fills.map((f) => f.symbol));
    expect(filledSymbols).toEqual(new Set(['A'])); // 봉0 신호도 A 만 허용됨
  });

  it('context.tradableSymbols 가 전략에 전달된다', () => {
    let seenAtFirstBar: ReadonlySet<string> | null | undefined;
    const spy: TradingStrategy<unknown, null> = {
      id: 'spy-tradable',
      version: '1.0.0',
      name: 'spy',
      description: 'spy',
      parameterSchema: z.unknown(),
      initialize: () => null,
      onBars(context: StrategyBarContext) {
        if (seenAtFirstBar === undefined) seenAtFirstBar = context.tradableSymbols;
        return { orders: [] };
      },
    };

    runBacktest(spy as never, {
      candles: [bar(0, 100), bar(1, 100)],
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['A'] }],
    });

    expect(seenAtFirstBar).toBeInstanceOf(Set);
    expect([...(seenAtFirstBar as ReadonlySet<string>)]).toEqual(['A']);
  });
});
