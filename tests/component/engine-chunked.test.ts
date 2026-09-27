import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest, runBacktestCancellable, type BacktestRunInput } from '../../src/runtime/modules/backtest/domain/engine.js';
import type { Candle } from '../../src/runtime/modules/market-data/domain/candle.js';
import type { TradingStrategy } from '../../src/runtime/modules/strategy/domain/strategy.js';
import { crossSectionalMomentumStrategy } from '../../src/runtime/modules/strategy/strategies/cross-sectional-momentum.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 6);
const symbols = ['A', 'B', 'C'] as const;

function candle(day: number, symbol: string): Candle {
  const base = 100 + day * 3 + symbols.indexOf(symbol as typeof symbols[number]) * 7;
  return {
    symbol, market: 'KR', timeframe: '1d', tsMs: START + day * DAY,
    open: base, high: base + 2, low: base - 2, close: base + 1, volume: 1000 + day,
  };
}

function strategy(observedHistory?: number[]): TradingStrategy<unknown, { step: number }> {
  return {
    id: 'chunk-boundary', version: '1', name: '분할 경계', description: '분할 경계',
    parameterSchema: z.unknown(), historyLookbackBars: () => 3,
    initialize: () => ({ step: 0 }),
    onBars(context, state) {
      const history = context.getHistory('A');
      observedHistory?.push(history.length);
      const orders = state.step === 0
        ? [{ symbol: 'A', side: 'BUY' as const, quantity: 2 }]
        : state.step === 4
          ? [{ symbol: 'A', side: 'SELL' as const, quantity: 2 }]
          : [];
      state.step += 1;
      return { orders };
    },
  };
}

const candles = Array.from({ length: 9 }, (_, day) => symbols.map((symbol) => candle(day, symbol))).flat();
const baseInput: Omit<BacktestRunInput, 'candles' | 'candleBatches'> = {
  initialCash: 10_000,
  execution: {
    cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
    slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
    rules: { tickSize: 0, minOrderQty: 1, maxVolumeParticipationRate: 0.5 },
  },
  parameters: {}, randomSeed: 17, maxPositions: 3,
  tradeFromTsMs: START + DAY,
  resultPeriod: { fromTsMs: START + DAY, toTsMs: START + 8 * DAY },
  universeSchedule: [
    { fromTsMs: START + DAY, symbols: [...symbols] },
    { fromTsMs: START + 5 * DAY, symbols: ['B', 'C'] },
  ],
  marketTradingTsMs: Array.from({ length: 9 }, (_, day) => START + day * DAY),
  delistedTsMsBySymbol: new Map([['A', [START + 7 * DAY]]]),
};

function batches(daysPerBatch: number): () => Iterable<readonly Candle[]> {
  return function* () {
    for (let day = 0; day < 9; day += daysPerBatch)
      yield candles.slice(day * symbols.length, (day + daysPerBatch) * symbols.length);
  };
}

describe('날짜 묶음 백테스트', () => {
  it.each([1, 2, 4, 9])('%i일 묶음은 전체 입력과 같은 결과를 낸다', (daysPerBatch) => {
    const expected = runBacktest(strategy(), { ...baseInput, candles });
    const historyLengths: number[] = [];
    const actual = runBacktest(strategy(historyLengths), {
      ...baseInput, candleBatches: batches(daysPerBatch),
    });
    expect(actual).toEqual(expected);
    expect(Math.max(...historyLengths)).toBe(3);
  });

  it('실제 모멘텀 전략의 이력 창과 거래 결과를 전체 입력과 같게 유지한다', () => {
    const longCandles = Array.from({ length: 35 }, (_, day) =>
      symbols.map((symbol) => candle(day, symbol))).flat();
    const input = {
      ...baseInput,
      parameters: { formationDays: 20, skipDays: 0, topN: 1, absoluteMomentumFilter: true },
      tradeFromTsMs: START,
      resultPeriod: { fromTsMs: START, toTsMs: START + 34 * DAY },
      universeSchedule: [0, 23, 30].map((day) => ({
        fromTsMs: START + day * DAY, symbols: [...symbols],
      })),
      marketTradingTsMs: Array.from({ length: 35 }, (_, day) => START + day * DAY),
      delistedTsMsBySymbol: new Map<string, number[]>(),
    };
    const expected = runBacktest(crossSectionalMomentumStrategy, {
      ...input, candles: longCandles,
    });
    const actual = runBacktest(crossSectionalMomentumStrategy, {
      ...input,
      candleBatches: function* () {
        for (let index = 0; index < longCandles.length; index += symbols.length * 4)
          yield longCandles.slice(index, index + symbols.length * 4);
      },
    });
    expect(actual).toEqual(expected);
    expect(actual.fills.length).toBeGreaterThan(0);
  });

  it('비동기 취소 가능 실행도 같은 결과를 낸다', async () => {
    const expected = runBacktest(strategy(), { ...baseInput, candles });
    const actual = await runBacktestCancellable(strategy(), {
      ...baseInput, candleBatches: batches(2),
    });
    expect(actual).toEqual(expected);
  });

  it('첫 봉 집계 중 취소 요청을 처리한다', async () => {
    let cancelled = false;
    let sourcePasses = 0;
    const source = function* () {
      sourcePasses += 1;
      yield* batches(1)();
    };
    setImmediate(() => { cancelled = true; });
    const result = await runBacktestCancellable(strategy(), {
      ...baseInput, candleBatches: source,
    }, { shouldCancel: () => cancelled });
    expect(result.cancelled).toBe(true);
    expect(result.processedBars).toBe(0);
    expect(sourcePasses).toBe(1);
  });

  it('봉 집계 후 coverage 확인 중 취소 요청을 처리한다', async () => {
    let cancelled = false;
    let sourcePasses = 0;
    const source = function* () {
      sourcePasses += 1;
      if (sourcePasses === 2) setImmediate(() => { cancelled = true; });
      yield* batches(1)();
    };
    const result = await runBacktestCancellable(strategy(), {
      ...baseInput, candleBatches: source,
    }, { shouldCancel: () => cancelled });
    expect(result.cancelled).toBe(true);
    expect(result.processedBars).toBe(0);
    expect(sourcePasses).toBe(2);
  });

  it('이력 상한을 선언하지 않은 전략은 분할 실행을 거부한다', () => {
    const unsupported = { ...strategy(), historyLookbackBars: undefined };
    expect(() => runBacktest(unsupported, {
      ...baseInput, candleBatches: batches(1),
    })).toThrow('이력 상한');
  });

  it('시간이 역행하는 입력은 실행 전에 거부한다', () => {
    expect(() => runBacktest(strategy(), {
      ...baseInput,
      candleBatches: () => [candles.slice(3, 6), candles.slice(0, 3)],
    })).toThrow('날짜·종목 오름차순');
  });
});
