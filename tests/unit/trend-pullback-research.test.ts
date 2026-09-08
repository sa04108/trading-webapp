import { describe, expect, it } from 'vitest';
import { trendPullbackParameters, trendPullbackStrategy } from '../../scripts/research/trend-pullback.js';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';

const start = Date.parse('2025-01-06');
const day = 86_400_000;
const rising = Array.from({ length: 80 }, (_, i) => 100 + i * 2);

function run(prices: number[], facts: Fact[] = [], overrides = {}) {
  const candles: Candle[] = prices.map((price, i) => ({
    symbol: 'A', market: 'KR', timeframe: '1d', tsMs: start + i * day,
    open: price, high: price * 1.005, low: price * 0.995, close: price, volume: 10_000,
  }));
  return runBacktest(trendPullbackStrategy, {
    candles, facts, initialCash: 100_000, parameters: trendPullbackParameters.parse(overrides), randomSeed: 204, maxPositions: 5,
    execution: { cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
      slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } },
  });
}

describe('연구용 단기 추세 눌림목', () => {
  it('상승 추세의 과매도를 다음 시가에 사고 회복 뒤 다음 시가에 판다', () => {
    const result = run([...rising, 252, 246, 240, 250, 260, 270]);
    expect(result.fills.map((f) => [f.side, f.tsMs, f.price])).toEqual([
      ['BUY', start + 82 * day, 240], ['SELL', start + 84 * day, 260],
    ]);
    expect(result.trades[0]?.exitReason).toBe('눌림 회복');
  });

  it('하락 추세의 낮은 RSI에는 매수하지 않는다', () => {
    expect(run(Array.from({ length: 100 }, (_, i) => 300 - i)).fills).toHaveLength(0);
  });

  it('액면분할 자체로 가짜 과매도 신호가 생기지 않는다', () => {
    const prices = [...rising, 260, 262, 264, 266].map((p, i) => i >= 70 ? p / 5 : p);
    const facts: Fact[] = [{ scope: 'SYMBOL', key: 'A', field: 'SPLIT_RATIO',
      periodKey: new Date(start + 70 * day).toISOString().slice(0, 10), asOfTsMs: start,
      value: 5, unit: 'RATIO' }];
    expect(run(prices, facts).fills).toHaveLength(0);
  });

  it('미래 반등 크기가 이전 진입 시점이나 수량을 바꾸지 않는다', () => {
    const first = run([...rising, 252, 246, 240, 250, 260]);
    const second = run([...rising, 252, 246, 240, 500, 900]);
    expect(first.fills[0]).toEqual(second.fills[0]);
  });

  it('보유 상한을 넘으면 회복하지 않아도 다음 시가에 청산한다', () => {
    const result = run([...rising, 252, 246, 240, 239, 238, 237], [], { maxHoldBars: 2, stopAtrMultiplier: 5 });
    expect(result.trades[0]?.exitReason).toBe('단기 보유 상한');
    expect(result.trades[0]?.exitTsMs).toBe(start + 84 * day);
  });
});
