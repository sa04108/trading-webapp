import { describe, expect, it } from 'vitest';
import { resetUnheldPriceState } from '../../src/runtime/modules/backtest/domain/action-gap.js';
import { runBacktest } from '../../src/runtime/modules/backtest/domain/engine.js';
import { CORPORATE_ACTION_FIELD } from '../../src/runtime/modules/facts/domain/fact.js';
import { rangeBreakoutStrategy } from '../../src/runtime/modules/strategy/strategies/range-breakout.js';
import { emaTrendSwitchStrategy } from '../../src/runtime/modules/strategy/strategies/ema-trend-switch.js';
import { rsiReversionStrategy } from '../../src/runtime/modules/strategy/strategies/rsi-reversion.js';
import { bootstrapTradingSymbolHistory } from '../../src/workers/trading-symbol-history.js';

const DAY = 86_400_000, start = Date.UTC(2026, 0, 1), symbol = '005930';
const execution = { cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 }, slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } };
const bars = Array.from({ length: 26 }, (_, i) => {
  const close = i < 12 ? 100 + i : i < 20 ? 56 : 56 + (i - 20) * 2;
  return { symbol, market: 'KR' as const, timeframe: '1d' as const, tsMs: start + i * DAY, open: close, high: close + 1, low: close - 1, close, volume: 1000 };
});
const split = { effectiveTsMs: start + 12 * DAY, ratio: 2 };
interface TestSymbol { holding: { pendingEntry: boolean }; entryFilter: { wasHeld: boolean; cooldown: number }; atr: { atr: number | null } }
interface TestState { bySymbol: Map<string, TestSymbol>; groupOf?: unknown; warmup?: { closesBySymbol: Map<string, Map<number, number>> } }

describe('new and returning swing symbol history', () => {
  it.each([rangeBreakoutStrategy, emaTrendSwitchStrategy, rsiReversionStrategy])('$id reconstructs indicators and split-adjusted correlation and advances an exited symbol cooldown', (strategy) => {
    const parameters = strategy.parameterSchema.parse({ lookbackBars: 2, atrPeriod: 2, fastEmaBars: 2, slowEmaBars: 5, rsiPeriod: 2, correlationBars: 20, trendSmaBars: 2, minAverageTradingValueKrw: 0 });
    let reference!: TestState;
    const wrapped = { ...strategy, onBars: (ctx: never, state: never, p: never) => { const decision = strategy.onBars(ctx, state, p); reference = structuredClone(state) as TestState; return decision; } };
    runBacktest(wrapped, { candles: bars, parameters, initialCash: 100000, execution, randomSeed: 1, maxPositions: 1, tradeFromTsMs: start + 26 * DAY,
      facts: [{ scope: 'SYMBOL', key: symbol, field: CORPORATE_ACTION_FIELD, periodKey: '2026-01-13', asOfTsMs: start, value: 2, unit: 'RATIO' }] });
    const freshState = strategy.initialize({ symbols: [symbol], initialCash: 100000, rng: () => 0.5 }) as TestState;
    bootstrapTradingSymbolHistory({ strategy, state: freshState, parameters, initialCash: 100000, beforeTsMs: start + 26 * DAY, histories: new Map([[symbol, bars]]), actions: new Map([[symbol, [split]]]) });
    expect(freshState.bySymbol.get(symbol)).toEqual(reference.bySymbol.get(symbol));
    if (freshState.warmup) expect(freshState.warmup.closesBySymbol.get(symbol)).toEqual(reference.warmup!.closesBySymbol.get(symbol));
    const state = strategy.initialize({ symbols: [symbol, '000660'], initialCash: 100000, rng: () => 0.5 }) as TestState;
    const existing = structuredClone(reference.bySymbol.get(symbol)!);
    existing.holding.pendingEntry = true;
    existing.entryFilter.cooldown = 3;
    existing.entryFilter.wasHeld = true;
    existing.atr.atr = 999;
    state.bySymbol.set(symbol, existing);
    if (state.warmup) state.warmup.closesBySymbol.set(symbol, new Map([[0, 999]]));
    const other = { marker: 'unchanged' };
    state.bySymbol.set('000660', other as unknown as TestSymbol);
    const group = state.groupOf;
    expect(() => bootstrapTradingSymbolHistory({ strategy, state, parameters, initialCash: 100000, beforeTsMs: start + 26 * DAY, histories: new Map([[symbol, bars]]), actions: new Map([[symbol, [split]]]) })).toThrow(/이전 처리 시각/);
    bootstrapTradingSymbolHistory({ strategy, state, parameters, initialCash: 100000, beforeTsMs: start + 26 * DAY, histories: new Map([[symbol, bars]]), actions: new Map([[symbol, [split]]]), lastSeen: { [symbol]: bars[23]!.tsMs } });
    const actual = state.bySymbol.get(symbol)!, expected = reference.bySymbol.get(symbol)!;
    expect({ ...actual, holding: expected.holding, entryFilter: { ...actual.entryFilter, wasHeld: expected.entryFilter.wasHeld, cooldown: expected.entryFilter.cooldown } }).toEqual(expected);
    expect(actual.holding.pendingEntry).toBe(false);
    expect(actual.entryFilter).toMatchObject({ wasHeld: false, cooldown: 5 });
    expect(state.bySymbol.get('000660')).toBe(other);
    expect(state.groupOf).toBe(group);
    if (state.warmup) expect(state.warmup.closesBySymbol.get(symbol)).toEqual(reference.warmup!.closesBySymbol.get(symbol));
    resetUnheldPriceState(state, symbol);
    expect(state.bySymbol.get(symbol)?.entryFilter).toMatchObject({ wasHeld: false, cooldown: 5 });
    expect(state.bySymbol.get(symbol)?.atr.atr).toBeNull();
    expect(state.bySymbol.get('000660')).toBe(other);
  });
});
