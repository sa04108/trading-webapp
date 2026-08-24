import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile, OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 5);

const LIQUIDITY_LIMITED: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1, maxVolumeParticipationRate: 0.1 },
};

function bar(index: number, volume: number): Candle {
  return {
    symbol: 'A', market: 'KR', venue: 'KOSPI', timeframe: '1d',
    tsMs: START + index * DAY,
    open: 100, high: 100, low: 100, close: 100, volume,
  };
}

function strategy(decisions: readonly (readonly OrderIntent[])[]): TradingStrategy<unknown, { index: number }> {
  return {
    id: 'liquidity-test', version: '1', name: 'test', description: 'test',
    parameterSchema: z.unknown(),
    initialize: () => ({ index: 0 }),
    onBars(_context, state) {
      const orders = decisions[state.index] ?? [];
      state.index += 1;
      return { orders };
    },
  };
}

function run(decisions: readonly (readonly OrderIntent[])[], volumes = [100, 100, 100]) {
  return runBacktest(strategy(decisions) as never, {
    candles: volumes.map((volume, index) => bar(index, volume)),
    initialCash: 1_000_000,
    execution: LIQUIDITY_LIMITED,
    parameters: {},
    randomSeed: 42,
    maxPositions: 5,
  });
}

describe('직전 거래 봉 거래량 participation 체결 한도', () => {
  it('한도까지만 체결하고 매수 잔량을 폐기한다', () => {
    const result = run([[{ symbol: 'A', side: 'BUY', quantity: 50 }]]);
    expect(result.fills.map((fill) => fill.quantity)).toEqual([10]);
    expect(result.openPositions[0]?.quantity).toBe(10);
    expect(result.warnings.some((warning) => warning.includes('축소된 체결 시도 1건'))).toBe(true);
  });

  it('같은 봉의 같은 종목 주문들이 하나의 거래량 한도를 공유한다', () => {
    const result = run([
      [],
      [
        { symbol: 'A', side: 'BUY', quantity: 8 },
        { symbol: 'A', side: 'BUY', quantity: 8 },
      ],
    ]);
    expect(result.fills.map((fill) => fill.quantity)).toEqual([8, 2]);
    expect(result.openPositions[0]?.quantity).toBe(10);
  });

  it('직전 봉 거래량이 0이면 주문을 체결하지 않는다', () => {
    const result = run([[{ symbol: 'A', side: 'BUY', quantity: 1 }]], [0, 100, 100]);
    expect(result.fills).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('거부된 체결 시도 1건'))).toBe(true);
  });

  it('청산 주문도 한도까지만 체결한다', () => {
    const result = run([
      [{ symbol: 'A', side: 'BUY', quantity: 50 }],
      [{ symbol: 'A', side: 'SELL', quantity: 50, reason: 'EXIT' }],
    ], [1_000, 100, 100]);
    expect(result.fills.map((fill) => [fill.side, fill.quantity])).toEqual([
      ['BUY', 50],
      ['SELL', 10],
    ]);
    expect(result.openPositions[0]?.quantity).toBe(40);
  });

  it('매도 잔량은 다음 거래 봉에서 같은 한도로 재시도한다', () => {
    const result = run([
      [{ symbol: 'A', side: 'BUY', quantity: 50 }],
      [{ symbol: 'A', side: 'SELL', quantity: 50, reason: 'EXIT' }],
    ], [1_000, 100, 100, 100]);
    expect(result.fills.map((fill) => [fill.side, fill.quantity])).toEqual([
      ['BUY', 50],
      ['SELL', 10],
      ['SELL', 10],
    ]);
    expect(result.openPositions[0]?.quantity).toBe(30);
  });

  it('부분 trim 잔량만 재시도해 보유분 전체를 청산하지 않는다', () => {
    const result = run([
      [{ symbol: 'A', side: 'BUY', quantity: 50 }],
      [{ symbol: 'A', side: 'SELL', quantity: 25, reason: 'TRIM' }],
    ], [1_000, 100, 100, 100, 100]);
    expect(result.fills.map((fill) => [fill.side, fill.quantity])).toEqual([
      ['BUY', 50],
      ['SELL', 10],
      ['SELL', 10],
      ['SELL', 5],
    ]);
    expect(result.openPositions[0]?.quantity).toBe(25);
    expect(result.metrics.tradeCount).toBe(3);
  });

  it('거래량 0으로 거부된 매도를 다음 체결 가능 봉에서 재시도한다', () => {
    const result = run([
      [{ symbol: 'A', side: 'BUY', quantity: 50 }],
      [{ symbol: 'A', side: 'SELL', quantity: 50, reason: 'EXIT' }],
    ], [1_000, 0, 100, 100]);
    expect(result.fills.map((fill) => [fill.side, fill.quantity])).toEqual([
      ['BUY', 50],
      ['SELL', 10],
    ]);
    expect(result.openPositions[0]?.quantity).toBe(40);
  });

  it('같은 봉의 매도와 매수가 같은 종목 한도를 공유한다', () => {
    const result = run([
      [{ symbol: 'A', side: 'BUY', quantity: 10 }],
      [
        { symbol: 'A', side: 'SELL', quantity: 8, reason: 'TRIM' },
        { symbol: 'A', side: 'BUY', quantity: 8 },
      ],
    ], [1_000, 100, 100]);
    expect(result.fills.map((fill) => [fill.side, fill.quantity])).toEqual([
      ['BUY', 10],
      ['SELL', 8],
      ['BUY', 2],
    ]);
    expect(result.openPositions[0]?.quantity).toBe(4);
  });

  it('상장폐지 강제정산은 마지막 봉에 잔량을 남기지 않는다', () => {
    const result = runBacktest(strategy([
      [{ symbol: 'A', side: 'BUY', quantity: 50 }],
    ]) as never, {
      candles: [1_000, 100, 100].map((volume, index) => bar(index, volume)),
      initialCash: 1_000_000,
      execution: LIQUIDITY_LIMITED,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
    });
    expect(result.fills.map((fill) => [fill.side, fill.quantity, fill.reason])).toEqual([
      ['BUY', 50, undefined],
      ['SELL', 50, 'DELISTED'],
    ]);
    expect(result.openPositions).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('축소된 체결 시도'))).toBe(false);
  });

  it('편출 강제 청산은 잔량을 재시도해 완전 청산하고 훅을 한 번만 부른다', () => {
    const forcedExitSymbols: string[] = [];
    const forcedExitStrategy: TradingStrategy<unknown, { index: number }> = {
      ...strategy([]),
      initialize: () => ({ index: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] = state.index === 0
          ? [{ symbol: 'A', side: 'BUY', quantity: 50 }]
          : [];
        state.index += 1;
        return { orders };
      },
      onForcedExit(symbol) {
        forcedExitSymbols.push(symbol);
      },
    };
    const result = runBacktest(forcedExitStrategy as never, {
      candles: [1_000, 100, 100, 100, 100, 100, 100, 100]
        .map((volume, index) => bar(index, volume)),
      initialCash: 1_000_000,
      execution: LIQUIDITY_LIMITED,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, symbols: ['A'] },
        { fromTsMs: START + 2 * DAY, symbols: ['B'] },
      ],
    });
    expect(result.fills.filter((fill) => fill.side === 'SELL').map((fill) => fill.quantity))
      .toEqual([10, 10, 10, 10, 10]);
    expect(result.openPositions).toEqual([]);
    expect(forcedExitSymbols).toEqual(['A']);
    expect(result.warnings.some((warning) => warning.includes('미청산 포지션'))).toBe(false);
  });

  it('이미 닫힌 포지션의 중복 매도를 유동성 거부로 세지 않는다', () => {
    const result = run([
      [{ symbol: 'A', side: 'BUY', quantity: 10 }],
      [
        { symbol: 'A', side: 'SELL', quantity: 10 },
        { symbol: 'A', side: 'SELL', quantity: 10 },
      ],
    ], [1_000, 100, 100]);
    expect(result.openPositions).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('거부된 체결 시도'))).toBe(false);
  });

  it.each([0, Number.NaN, 1.01])('잘못된 participation 비율 %s를 거부한다', (rate) => {
    expect(() => runBacktest(strategy([]) as never, {
      candles: [bar(0, 100)],
      initialCash: 1_000_000,
      execution: {
        ...LIQUIDITY_LIMITED,
        rules: { ...LIQUIDITY_LIMITED.rules, maxVolumeParticipationRate: rate },
      },
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    })).toThrow('maxVolumeParticipationRate는 0 초과 1 이하여야 합니다');
  });
});
