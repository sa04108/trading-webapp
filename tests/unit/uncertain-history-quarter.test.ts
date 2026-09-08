import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import { createRecoveryRotation } from '../../scripts/quarter-research/recovery-rotation.js';
import { historySinceEvent, withUncertainHistory } from '../../scripts/quarter-research/uncertain-history.js';
import { windowsFromStarts, type MacroPoint } from '../../scripts/quarter-research/quarter-engine.js';

describe('미확인 사건 이후 가격과 조건 발생일 평가', () => {
  const tsMs = Date.parse('2026-09-08');
  const bars: Candle[] = Array.from({ length: 126 }, (_, i) => {
    const close = 1000 + i * 2 + (i % 2) * 5;
    return { symbol: 'A', tsMs: tsMs - (125 - i) * 86_400_000, market: 'KR', venue: 'KOSPI', timeframe: '1d',
      open: close, high: close, low: close, close, volume: 1_000_000 };
  });
  const macro: MacroPoint = { date: '2026-09-08', tsMs, kospi: 110, kospiSma20: 100, kospiSma60: 100,
    kospiSma120: 100, kospiRet20: .1, kospiRet60: -.1, kospiRet120: .2, kospiVol20: .4,
    kospiDrawdown60: -.2, kosdaqRet60: .1, breadth60: .5, vix: 15, oilRet20: 0, fxRet20: 0, rate: 3, rateChange60: 0 };
  const context: StrategyBarContext = { tsMs, isRebalanceBar: true, bars: new Map([['A', bars.at(-1)!]]),
    getHistory: () => bars, portfolio: { cash: 100_000_000, equity: 100_000_000, positions: new Map() },
    rng: () => .5, fundamentals: () => null, corporateActions: () => [], selectionMetric: () => null,
    tradableSymbols: new Set(['A']), activeUniverseSymbols: new Set(['A']) };

  it('미래 사건은 이력을 자르지 않고 당일에는 과거 사건 중 최신 경계부터 사용한다', () => {
    expect(historySinceEvent(bars, [tsMs + 1], tsMs)).toBe(bars);
    expect(historySinceEvent(bars, [bars[40]!.tsMs, bars[100]!.tsMs, tsMs + 1], tsMs)).toEqual(bars.slice(100));
    expect(historySinceEvent(bars, [tsMs + 1], tsMs + 1)).toEqual([]);
  });

  it('목표를 정한 뒤 미확인 사건이 발생하면 다음 단계의 매수를 차단한다', () => {
    const next = tsMs + 86_400_000;
    const strategy = createRecoveryRotation(new Map([[tsMs, macro], [next, { ...macro, tsMs: next }]]));
    const wrapped = withUncertainHistory(strategy, [{ symbol: 'A', date: '2026-09-09' }], tsMs);
    const p = strategy.parameterSchema.parse({});
    const state = strategy.initialize({ symbols: ['A'], initialCash: 100_000_000, rng: context.rng });
    wrapped.strategy.onBars(context, state, p);
    expect(state.pending).toHaveLength(1);
    const nextBar = { ...bars.at(-1)!, tsMs: next };
    const decision = wrapped.strategy.onBars({ ...context, tsMs: next, isRebalanceBar: false,
      bars: new Map([['A', nextBar]]), getHistory: () => [...bars, nextBar] }, state, p);
    expect(decision.orders).toEqual([]);
    expect(state.pending).toBeNull();
    expect(wrapped.audit()).toEqual([{ symbol: 'A', bars: 1, first: '2026-09-09', last: '2026-09-09' }]);
  });

  it('보유 포지션은 이력이 짧아져도 실제 현재 가격으로 청산 신호를 낸다', () => {
    const strategy = createRecoveryRotation(new Map([[tsMs, { ...macro, kospi: 80, kospiRet20: -.1 }]]));
    const wrapped = withUncertainHistory(strategy, [{ symbol: 'A', date: '2026-09-08' }], tsMs);
    const p = strategy.parameterSchema.parse({});
    const state = strategy.initialize({ symbols: ['A'], initialCash: 100_000_000, rng: context.rng });
    const decision = wrapped.strategy.onBars({ ...context, portfolio: { ...context.portfolio,
      positions: new Map([['A', { symbol: 'A', quantity: 50, avgEntryPrice: 1000, entryCosts: 0, entryTsMs: bars[0]!.tsMs }]]) } }, state, p);
    expect(decision.orders).toEqual([expect.objectContaining({ symbol: 'A', side: 'SELL', quantity: 50 })]);
  });

  it('월중 시작의 달력 3개월을 계산하며 잘못된 고정 시작점을 버리지 않는다', () => {
    const days = ['2020-04-09', '2020-04-10', '2020-07-08', '2020-07-09'];
    expect(windowsFromStarts(days, '2020-01-01', '2020-12-31', ['2020-04-09'], true)[0]?.end).toBe('2020-07-08');
    expect(() => windowsFromStarts(days, '2020-01-01', '2020-12-31', ['2020-04-09', '2020-04-09'], true)).toThrow();
    expect(() => windowsFromStarts(days, '2020-01-01', '2020-12-31', ['2020-04-11'], true)).toThrow();
    expect(() => windowsFromStarts(days, '2020-01-01', '2020-07-07', ['2020-04-09'], true)).toThrow();
  });
});
