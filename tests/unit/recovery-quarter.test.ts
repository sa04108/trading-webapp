import { describe, expect, it } from 'vitest';
import type { StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { createRecoveryRotation } from '../../scripts/quarter-research/recovery-rotation.js';
import type { MacroPoint } from '../../scripts/quarter-research/quarter-engine.js';

describe('회복 전략의 진입 대기와 비중', () => {
  const tsMs = Date.UTC(2026, 8, 8);
  const base: MacroPoint = { date: '2026-09-08', tsMs, kospi: 110, kospiSma20: 105, kospiSma60: 100,
    kospiSma120: 100, kospiRet20: .05, kospiRet60: -.10, kospiRet120: .1,
    kospiVol20: .3, kospiDrawdown60: -.1, kosdaqRet60: -.1, breadth60: .6,
    vix: 15, oilRet20: .05, fxRet20: -.01, rate: 3, rateChange60: .5 };

  const candles: Candle[] = Array.from({ length: 126 }, (_, i) => {
    const close = 1000 + i * 2 + (i % 2) * 5;
    return { symbol: 'A', tsMs: tsMs - (125 - i) * 86_400_000, market: 'KR', venue: 'KOSPI',
      timeframe: '1d', open: close, high: close, low: close, close, volume: 1_000_000 };
  });
  const context: StrategyBarContext = { tsMs, isRebalanceBar: true, bars: new Map([['A', candles.at(-1)!]]),
    getHistory: () => candles, portfolio: { cash: 100_000_000, equity: 100_000_000, positions: new Map() },
    rng: () => .5, fundamentals: () => null, corporateActions: () => [],
    tradableSymbols: new Set(['A']), activeUniverseSymbols: new Set(['A']), selectionMetric: () => null };

  it('매수 단계 전에 시장 조건이 꺼지면 이전 목표를 취소한다', () => {
    const nextTs = tsMs + 86_400_000;
    const macro = new Map([[tsMs, base], [nextTs, { ...base, tsMs: nextTs, kospi: 90, kospiRet20: -.1 }]]);
    const strategy = createRecoveryRotation(macro);
    const p = strategy.parameterSchema.parse({});
    const state = strategy.initialize({ symbols: ['A'], initialCash: 100_000_000, rng: context.rng });
    expect(strategy.onBars(context, state, p).orders).toHaveLength(0);
    expect(state.pending).toHaveLength(1);
    const decision = strategy.onBars({ ...context, tsMs: nextTs, isRebalanceBar: false }, state, p);
    expect(decision.orders).toHaveLength(0);
    expect(state.pending).toBeNull();
  });

  it('유가 충격 뒤 매수 단계에서는 앞서 정한 비중을 그대로 사지 않는다', () => {
    const nextTs = tsMs + 86_400_000;
    const strategy = createRecoveryRotation(new Map([[tsMs, base], [nextTs, { ...base, tsMs: nextTs, oilRet20: .3 }]]));
    const p = strategy.parameterSchema.parse({});
    const state = strategy.initialize({ symbols: ['A'], initialCash: 100_000_000, rng: context.rng });
    strategy.onBars(context, state, p);
    expect(state.pending?.[0]?.weight).toBeGreaterThan(.5 / 3);
    const decision = strategy.onBars({ ...context, tsMs: nextTs, isRebalanceBar: false }, state, p);
    expect(decision.orders).toHaveLength(1);
    expect(decision.orders[0]!.quantity * candles.at(-1)!.close / context.portfolio.equity).toBeLessThanOrEqual(.5 / 3);
  });
});
