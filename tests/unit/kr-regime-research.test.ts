import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { comparison, withRegime, type MacroPoint } from '../../scripts/research/kr-regime-engine.js';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const start = Date.parse('2025-01-06');
const day = 86_400_000;
const alwaysBuy: AnyTradingStrategy = {
  id: 'research-fixture', version: '1', name: '테스트', description: '테스트',
  parameterSchema: z.unknown(), initialize: () => null,
  onBars: () => ({ orders: [{ symbol: 'A', side: 'BUY', quantity: 1_000 }] }),
};

function run(allowed: boolean[], prices: number[]) {
  const candles: Candle[] = prices.map((price, i) => ({
    symbol: 'A', market: 'KR', timeframe: '1d', tsMs: start + i * day,
    open: price, high: price, low: price, close: price, volume: 10_000,
  }));
  const days = candles.map((c) => c.tsMs);
  return runBacktest(withRegime(alwaysBuy, new Map(days.map((ts, i) => [ts, allowed[i]!])), days, days.at(-2)!), {
    candles, initialCash: 10_000, parameters: {}, randomSeed: 1, maxPositions: 5,
    execution: { cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
      slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } },
  });
}

describe('국면 연구의 체결과 비교 경계', () => {
  it('국면 종료 신호 뒤 시가에 청산하고 갭 손실도 포함한다', () => {
    const result = run([false, true, false, false, false], [100, 100, 100, 50, 50]);
    expect(result.fills.map((f) => [f.side, f.tsMs, f.quantity])).toEqual([
      ['BUY', start + 2 * day, 20], ['SELL', start + 3 * day, 20],
    ]);
    expect(result.metrics.finalEquity).toBe(9_000);
  });

  it('국면 밖에서는 매수하지 않는다', () => {
    expect(run([false, false, false, false], [100, 200, 300, 400]).fills).toHaveLength(0);
  });

  it('미래 가격을 바꾸어도 그 전 체결은 바뀌지 않는다', () => {
    const first = run([true, true, true, false, false], [100, 100, 110, 120, 130]);
    const second = run([true, true, true, false, false], [100, 100, 110, 300, 500]);
    expect(first.fills.filter((f) => f.tsMs < start + 3 * day))
      .toEqual(second.fills.filter((f) => f.tsMs < start + 3 * day));
  });

  it('매수 가능일부터 청산일까지 벤치마크를 포함하고 신호 전 수익은 빼놓는다', () => {
    const macro: MacroPoint[] = [100, 200, 220, 110, 150].map((price, i) => ({
      date: new Date(start + i * day).toISOString().slice(0, 10),
      ndxUsd: price, ndxKrw: price, ndxDate: '2025-01-03', fxDate: '2025-01-03',
      vix: 30, vixDate: '2025-01-03', rate: 3, rateDate: '2025-01-03', kospi: 100,
      regimes: { high_vol: i === 1, low_rate: false, kr_uptrend: false, high_vol_uptrend: false },
    }));
    const equity = [100, 100, 110, 55, 55].map((value, i) => ({ tsMs: start + i * day, equity: value }));
    const result = comparison(equity, macro, 'high_vol', '2025-01-07', '2025-01-10', 100);
    expect(result.activeDays).toBe(2);
    expect(result.episodes).toBe(1);
    expect(result.activeNdxKrwPct).toBeCloseTo(-45);
    expect(result.activeStrategyPct).toBeCloseTo(-45);
    expect(result.activeExcessPp).toBeCloseTo(0);
    expect(result.fullNdxKrwPct).toBeCloseTo(-25);
  });

  it('자산 관측을 빠뜨리면 비교 수익률을 만들지 않는다', () => {
    const macro = [{ date: '2025-01-06' }, { date: '2025-01-07' }] as MacroPoint[];
    expect(() => comparison([], macro, 'high_vol', '2025-01-07', '2025-01-07', 100)).toThrow('자산 관측 누락');
  });
});
