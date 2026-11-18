import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/runtime/modules/backtest/domain/engine.js';
import { crossSectionalMomentumStrategy as strategy } from '../../src/runtime/modules/strategy/strategies/cross-sectional-momentum.js';
import { reconcileState } from '../../src/server/modules/trading/infrastructure/strategy-lifecycle.js';
import { createOfficialKrxTradingCalendar } from '../../src/server/modules/market-data/infrastructure/krx/krx-trading-calendar.js';
import { calculate } from '../../src/workers/trading-decision-child.js';

const calendar = createOfficialKrxTradingCalendar();
const days: number[] = [];
for (let ts = Date.parse('2026-09-01T00:00:00Z'); days.length < 23; ts += 86_400_000) {
  if (calendar.classify(new Date(ts).toISOString().slice(0, 10), 'KOSPI').state === 'OPEN') days.push(ts);
}
const bars = days.map((tsMs, index) => ({ symbol: '005930', market: 'KR' as const, timeframe: '1d' as const, tsMs, open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index, volume: 10000 }));
const member = { symbol: '005930', marketCapKrw: '10000000', volume: 10000, tradingValueKrw: '1000000' };
const parameters = strategy.parameterSchema.parse({ formationDays: 20, skipDays: 0, topN: 1, marketTrendBars: 0, minAverageTradingValueKrw: 0 });
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const runtime = {
  resolver: { resolveOrDescribeNeeds: async () => ({ kind: 'READY', unionEntries: new Map(), schedule: [{ rebalanceDate: day(days[21]!), members: [member] }], dataExclusions: [], corporateActionExclusions: [] }) },
  candles: { getCandlesArray: async ({ fromTsMs, toTsMs }: { fromTsMs: number; toTsMs: number }) => bars.filter((bar) => bar.tsMs >= fromTsMs && bar.tsMs <= toTsMs) },
  actionCoverage: { getCoveredYears: () => new Map([['005930', [2025, 2026]]]), getGapYears: () => new Map() },
  facts: { getFacts: async () => [] },
};
const deployment = { strategyId: strategy.id, version: strategy.version, artifactHash: 'a'.repeat(64), parameters, createdAtMs: days[21], activatedAtMs: null, budgetKrw: 100000, randomSeed: 1, universeRule: { stages: [], rebalanceInterval: { unit: 'NONE', value: 1 } } };
const bundle = { formatVersion: 1, nodeMajor: 24, lifecycleAbi: 1, getStrategy: () => strategy, reconcileState };

describe('daily strategy decision parity', () => {
  it('preserves the momentum sell and buy phases through a live checkpoint', async () => {
    const observed = new Map<number, readonly unknown[]>();
    const wrapped = { ...strategy, onBars: (...args: Parameters<typeof strategy.onBars>) => { const result = strategy.onBars(...args); observed.set(args[0].tsMs, result.orders); return result; } };
    runBacktest(wrapped, { candles: bars, initialCash: 100000, parameters, randomSeed: 1, maxPositions: 1,
      tradeFromTsMs: days[21], universeSchedule: [{ fromTsMs: days[21]!, members: [member] }],
      execution: { cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 }, slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } } });
    const execute = (checkpoint: string | null, warmupOnly: boolean, ts: number) => calculate({ input: { deployment, portfolio: {}, cashKrw: 100000, checkpoint, warmupOnly }, date: day(ts), bundlePath: '' } as never, {} as never, bundle as never, runtime as never);
    const warm = await execute(null, true, days[20]!);
    const rebalance = await execute(warm.checkpoint, false, days[21]!);
    const buy = await execute(rebalance.checkpoint, false, days[22]!);
    expect(rebalance.orders).toEqual(observed.get(days[21]!));
    expect(buy.orders).toEqual(observed.get(days[22]!));
    expect(buy.orders).toEqual([{ symbol: '005930', side: 'BUY', quantity: 778, reason: expect.any(String) }]);
  });
});

import { lowPerHighRoeRankStrategy } from '../../src/runtime/modules/strategy/strategies/low-per-high-roe-rank.js';
import { valueQualityRankStrategy } from '../../src/runtime/modules/strategy/strategies/value-quality-rank.js';
import { earningsAccelerationRankStrategy } from '../../src/runtime/modules/strategy/strategies/earnings-acceleration-rank.js';
import type { Fact } from '../../src/runtime/modules/facts/domain/fact.js';

const longDays: number[] = [];
for (let ts = Date.parse('2026-06-01T00:00:00Z'); longDays.length < 63; ts += 86_400_000) {
  if (calendar.classify(day(ts), 'KOSPI').state === 'OPEN') longDays.push(ts);
}
const longBars = longDays.map((tsMs, index) => ({ ...bars[0]!, tsMs, open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index }));
const quarters = ['2024Q3', '2024Q4', '2025Q1', '2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2'];
const facts: Fact[] = [
  ...quarters.flatMap((periodKey, index) => (['OPERATING_INCOME', 'NET_INCOME'] as const).map((field) => ({ scope: 'SYMBOL' as const, key: member.symbol, field, periodKey, asOfTsMs: longDays[0]! - 1, value: index === 7 ? 500 : 100 + index * 20, unit: 'KRW' }))),
  ...(['TOTAL_EQUITY', 'CURRENT_ASSETS', 'TANGIBLE_ASSETS', 'CURRENT_LIABILITIES'] as const).map((field) => ({ scope: 'SYMBOL' as const, key: member.symbol, field, periodKey: '2026Q2', asOfTsMs: longDays[0]! - 1, value: field === 'CURRENT_LIABILITIES' ? 100 : 1000, unit: 'KRW' })),
];

describe('financial rank decision parity', () => {
  it.each([lowPerHighRoeRankStrategy, valueQualityRankStrategy, earningsAccelerationRankStrategy])('$id matches actual backtest rebalance and next-bar orders', async (rankStrategy) => {
    const rankParameters = rankStrategy.parameterSchema.parse({ topN: 1, marketTrendBars: 0, minAverageTradingValueKrw: 0, priceMomentumDays: 60, priceMomentumSkipDays: 0 });
    const rankDeployment = { ...deployment, strategyId: rankStrategy.id, version: rankStrategy.version, parameters: rankParameters, createdAtMs: longDays[61] };
    const rankRuntime = { ...runtime,
      resolver: { resolveOrDescribeNeeds: async () => ({ kind: 'READY', unionEntries: new Map(), schedule: [{ rebalanceDate: day(longDays[61]!), members: [member] }], dataExclusions: [], corporateActionExclusions: [] }) },
      candles: { getCandlesArray: async ({ fromTsMs, toTsMs }: { fromTsMs: number; toTsMs: number }) => longBars.filter((bar) => bar.tsMs >= fromTsMs && bar.tsMs <= toTsMs) },
      actionCoverage: { getCoveredYears: () => new Map([[member.symbol, [2024, 2025, 2026]]]), getGapYears: () => new Map() },
      factCoverage: { getCoverageState: () => new Map([[member.symbol, { verifiedYears: [2023, 2024, 2025, 2026], blockingGapYears: [] }]]) },
      facts: { getFacts: async () => facts },
    };
    const observed = new Map<number, readonly unknown[]>();
    const wrapped = { ...rankStrategy, onBars: (ctx: never, state: never, params: never) => { const result = rankStrategy.onBars(ctx, state, params); observed.set((ctx as { tsMs: number }).tsMs, result.orders); return result; } };
    runBacktest(wrapped, { candles: longBars, facts, initialCash: 100000, parameters: rankParameters, randomSeed: 1, maxPositions: 1, tradeFromTsMs: longDays[61], universeSchedule: [{ fromTsMs: longDays[61]!, members: [member] }], execution: { cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 }, slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } } });
    const execute = (checkpoint: string | null, warmupOnly: boolean, ts: number) => calculate({ input: { deployment: rankDeployment, portfolio: {}, cashKrw: 100000, checkpoint, warmupOnly }, date: day(ts), bundlePath: '' } as never, {} as never, { ...bundle, getStrategy: () => rankStrategy } as never, rankRuntime as never);
    const warm = await execute(null, true, longDays[60]!);
    const rebalance = await execute(warm.checkpoint, false, longDays[61]!);
    const buy = await execute(rebalance.checkpoint, false, longDays[62]!);
    expect(rebalance.orders).toEqual(observed.get(longDays[61]!));
    expect(buy.orders).toEqual(observed.get(longDays[62]!));
    expect(buy.orders).toEqual([{ symbol: member.symbol, side: 'BUY', quantity: 586, reason: expect.any(String) }]);
  });
});

import { rangeBreakoutStrategy } from '../../src/runtime/modules/strategy/strategies/range-breakout.js';
import { emaTrendSwitchStrategy } from '../../src/runtime/modules/strategy/strategies/ema-trend-switch.js';
import { rsiReversionStrategy } from '../../src/runtime/modules/strategy/strategies/rsi-reversion.js';

describe('swing decision parity', () => {
  it.each([rangeBreakoutStrategy, emaTrendSwitchStrategy, rsiReversionStrategy])('$id matches the first live order with backtest', async (swing) => {
    const swingParameters = swing.parameterSchema.parse({ lookbackBars: 2, atrPeriod: 2, breakoutBufferAtr: 0, fastEmaBars: 2, slowEmaBars: 5, entryThresholdPercent: 0.01, entryAtrMultiplier: 0, correlationBars: 20, rsiPeriod: 2, entryRsi: 45, minAverageTradingValueKrw: 0, trendSmaBars: 0 });
    const warmup = Math.max(1, swing.dataRequirements?.priceWarmupBars?.(swingParameters as never) ?? 1, swing.historyLookbackBars?.(swingParameters as never) ?? 1);
    const source = longBars.slice(-(warmup + 1)).map((bar, index) => {
      const close = swing.id === 'rsi-reversion' ? 200 - index + (index === warmup ? 1.9 : 0) : 100 + index * 2;
      return { ...bar, open: close, high: close + 0.5, low: close - 0.5, close };
    });
    const current = source.at(-1)!.tsMs, previous = source.at(-2)!.tsMs;
    const swingDeployment = { ...deployment, strategyId: swing.id, version: swing.version, parameters: swingParameters, createdAtMs: current };
    const swingRuntime = { ...runtime, candles: { getCandlesArray: async ({ fromTsMs, toTsMs }: { fromTsMs: number; toTsMs: number }) => source.filter((bar) => bar.tsMs >= fromTsMs && bar.tsMs <= toTsMs) }, resolver: { resolveOrDescribeNeeds: async () => ({ kind: 'READY', unionEntries: new Map(), schedule: [{ rebalanceDate: day(current), members: [member] }], dataExclusions: [], corporateActionExclusions: [] }) } };
    const observed = new Map<number, readonly unknown[]>();
    const wrapped = { ...swing, onBars: (ctx: never, state: never, params: never) => { const result = swing.onBars(ctx, state, params); observed.set((ctx as { tsMs: number }).tsMs, result.orders); return result; } };
    runBacktest(wrapped, { candles: source, initialCash: 100000, parameters: swingParameters, randomSeed: 1, maxPositions: 1, tradeFromTsMs: current, universeSchedule: [{ fromTsMs: current, members: [member] }], execution: { cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 }, slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } } });
    const execute = (checkpoint: string | null, warmupOnly: boolean, ts: number) => calculate({ input: { deployment: swingDeployment, portfolio: {}, cashKrw: 100000, checkpoint, warmupOnly }, date: day(ts), bundlePath: '' } as never, {} as never, { ...bundle, getStrategy: () => swing } as never, swingRuntime as never);
    const warm = await execute(null, true, previous);
    const decision = await execute(warm.checkpoint, false, current);
    expect(decision.orders).toEqual(observed.get(current));
    const expected = swing.id === 'range-breakout' ? { quantity: 192, reason: 'BREAKOUT' } : swing.id === 'ema-trend-switch' ? { quantity: 71, reason: 'TREND' } : { quantity: 54, reason: 'REVERSION' };
    expect(decision.orders).toEqual([{ symbol: member.symbol, side: 'BUY', ...expected }]);
  });
});

it('matches a breakout exit after a real next-open fill and a loss', async () => {
  const p = rangeBreakoutStrategy.parameterSchema.parse({ lookbackBars: 2, atrPeriod: 2, breakoutBufferAtr: 0, minAverageTradingValueKrw: 0, trendSmaBars: 0 });
  const warmup = Math.max(rangeBreakoutStrategy.dataRequirements!.priceWarmupBars!(p), rangeBreakoutStrategy.historyLookbackBars!(p));
  const dates = longDays.slice(-(warmup + 3));
  const source = dates.map((tsMs, i) => {
    const close = i < warmup ? 100 : i < warmup + 2 ? 110 : 80;
    return { ...bars[0]!, tsMs, open: i === warmup + 2 ? 80 : close, high: close + 1, low: close - 1, close };
  });
  const first = dates[warmup]!, fill = dates[warmup + 1]!, exit = dates[warmup + 2]!;
  const observed = new Map<number, readonly unknown[]>();
  const wrapped = { ...rangeBreakoutStrategy, onBars: (...args: Parameters<typeof rangeBreakoutStrategy.onBars>) => { const result = rangeBreakoutStrategy.onBars(...args); observed.set(args[0].tsMs, result.orders); return result; } };
  const backtest = runBacktest(wrapped, { candles: source, initialCash: 100000, parameters: p, randomSeed: 1, maxPositions: 1, tradeFromTsMs: first, universeSchedule: [{ fromTsMs: first, members: [member] }], execution: { cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 }, slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } } });
  const entryFill = backtest.fills[0]!;
  expect(entryFill).toMatchObject({ symbol: member.symbol, side: 'BUY', price: 110 });
  const liveRuntime = { ...runtime, candles: { getCandlesArray: async ({ fromTsMs, toTsMs }: { fromTsMs: number; toTsMs: number }) => source.filter((bar) => bar.tsMs >= fromTsMs && bar.tsMs <= toTsMs) }, resolver: { resolveOrDescribeNeeds: async () => ({ kind: 'READY', unionEntries: new Map(), schedule: [{ rebalanceDate: day(first), members: [member] }], dataExclusions: [], corporateActionExclusions: [] }) } };
  const liveDeployment = { ...deployment, strategyId: rangeBreakoutStrategy.id, version: rangeBreakoutStrategy.version, parameters: p, createdAtMs: first };
  const liveBundle = { ...bundle, getStrategy: () => rangeBreakoutStrategy };
  const execute = (checkpoint: string | null, warmupOnly: boolean, ts: number, held: boolean) => calculate({ input: { deployment: liveDeployment, portfolio: held ? { [member.symbol]: { quantity: entryFill.quantity, cost: entryFill.grossAmount, enteredAtMs: fill } } : {}, cashKrw: held ? 100000 - entryFill.grossAmount : 100000, checkpoint, warmupOnly }, date: day(ts), bundlePath: '' } as never, {} as never, liveBundle as never, liveRuntime as never);
  const warm = await execute(null, true, dates[warmup - 1]!, false);
  const entry = await execute(warm.checkpoint, false, first, false);
  expect(entry.orders).toEqual(observed.get(first));
  const held = await execute(entry.checkpoint, false, fill, true);
  expect(held.orders).toEqual(observed.get(fill));
  const sold = await execute(held.checkpoint, false, exit, true);
  expect(sold.orders).toEqual(observed.get(exit));
  expect(sold.orders).toEqual([{ symbol: member.symbol, side: 'SELL', quantity: entryFill.quantity, reason: 'STOP' }]);
});

it('matches changed membership, a partial forced exit, and deferred competing buys', async () => {
  const p = rangeBreakoutStrategy.parameterSchema.parse({ lookbackBars: 2, atrPeriod: 2, breakoutBufferAtr: 0, minAverageTradingValueKrw: 0, trendSmaBars: 0 });
  const dates = longDays.slice(35, 45);
  const first = dates[3]!, fillAt = dates[4]!, change = dates[5]!, partialAt = dates[6]!, releaseAt = dates[7]!, buyFillAt = dates[8]!;
  const outgoing = member;
  const incoming = ['000660', '035420'].map(symbol => ({ ...member, symbol }));
  const source = dates.flatMap((tsMs, i) => [outgoing, ...incoming].map(({ symbol }) => {
    const close = symbol === outgoing.symbol ? (i < 3 ? 100 : 110) : (i < 5 ? 100 : 110);
    const volume = symbol === outgoing.symbol && i >= 5 ? 10 : 10000;
    return { ...bars[0]!, symbol, tsMs, open: close, high: close + 1, low: close - 1, close, volume };
  }));
  const pin = [{ fromTsMs: dates[2]!, rebalanceDate: day(dates[2]!), members: [outgoing] }, { fromTsMs: change, rebalanceDate: day(change), members: incoming }];
  const scenarioRuntime = { ...runtime,
    resolver: { resolveOrDescribeNeeds: async (_rule: unknown, period: { to: string }) => ({ kind: 'READY', unionEntries: new Map(), schedule: pin.filter(entry => entry.rebalanceDate <= period.to), dataExclusions: [], corporateActionExclusions: [] }) },
    candles: { getCandlesArray: async (query: { symbols: string[]; fromTsMs: number; toTsMs: number }) => source.filter(bar => query.symbols.includes(bar.symbol) && bar.tsMs >= query.fromTsMs && bar.tsMs <= query.toTsMs) },
    actionCoverage: { getCoveredYears: () => new Map([outgoing, ...incoming].map(m => [m.symbol, [2025, 2026]])), getGapYears: () => new Map() },
  };
  const observed = new Map<number, readonly unknown[]>();
  const wrapped = { ...rangeBreakoutStrategy, onBars: (...args: Parameters<typeof rangeBreakoutStrategy.onBars>) => { const result = rangeBreakoutStrategy.onBars(...args); observed.set(args[0].tsMs, result.orders); return result; } };
  const result = runBacktest(wrapped, { candles: source, initialCash: 100000, parameters: p, randomSeed: 1, maxPositions: 3, tradeFromTsMs: first, universeSchedule: pin, execution: { cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 }, slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1, maxVolumeParticipationRate: 0.5 } } });
  const entryFill = result.fills.find(fill => fill.tsMs === fillAt && fill.symbol === outgoing.symbol)!;
  expect(entryFill).toMatchObject({ side: 'BUY', quantity: 76, price: 110 });
  const partial = result.fills.find(fill => fill.tsMs === partialAt && fill.symbol === outgoing.symbol)!;
  expect(partial).toMatchObject({ side: 'SELL', quantity: 5, price: 110 });
  const scenarioDeployment = { ...deployment, strategyId: rangeBreakoutStrategy.id, version: rangeBreakoutStrategy.version, parameters: p, createdAtMs: first };
  const bought = result.fills.filter(fill => fill.tsMs === releaseAt && fill.side === 'BUY');
  expect(bought.map(fill => ({ symbol: fill.symbol, quantity: fill.quantity }))).toEqual([{ symbol: '035420', quantity: 76 }, { symbol: '000660', quantity: 76 }]);
  const execute = (checkpoint: string | null, warmupOnly: boolean, ts: number, quantity: number, includeBought = false) => calculate({ input: { deployment: scenarioDeployment, portfolio: { ...(quantity ? { [outgoing.symbol]: { quantity, cost: quantity * 110, enteredAtMs: fillAt } } : {}), ...Object.fromEntries((includeBought ? bought : []).map(fill => [fill.symbol, { quantity: fill.quantity, cost: fill.grossAmount, enteredAtMs: releaseAt }])) }, cashKrw: 100000 - quantity * 110 - (includeBought ? bought.reduce((sum, fill) => sum + fill.grossAmount, 0) : 0), checkpoint, warmupOnly }, date: day(ts), bundlePath: '' } as never, {} as never, { ...bundle, getStrategy: () => rangeBreakoutStrategy } as never, scenarioRuntime as never);
  const warm = await execute(null, true, dates[2]!, 0);
  const entry = await execute(warm.checkpoint, false, first, 0);
  expect(entry.orders).toEqual(observed.get(first));
  const held = await execute(entry.checkpoint, false, fillAt, 76);
  const changed = await execute(held.checkpoint, false, change, 76);
  expect(changed.orders).toEqual([{ symbol: outgoing.symbol, side: 'SELL', quantity: 76, reason: 'REBALANCE_EXIT' }]);
  const afterPartial = await execute(changed.checkpoint, false, partialAt, 71);
  expect(afterPartial.orders).toContainEqual({ symbol: outgoing.symbol, side: 'SELL', quantity: 71, reason: 'REBALANCE_EXIT' });
  const purchases = afterPartial.orders.filter(order => order.side === 'BUY');
  expect(purchases.map(order => order.symbol)).toEqual(result.fills.filter(fill => fill.tsMs === releaseAt && fill.side === 'BUY').map(fill => fill.symbol));
  expect(purchases).toEqual([{ symbol: '035420', side: 'BUY', quantity: 76, reason: 'BREAKOUT' }, { symbol: '000660', side: 'BUY', quantity: 76, reason: 'BREAKOUT' }]);
  const next = await execute(afterPartial.checkpoint, false, releaseAt, 66, true);
  expect(next.orders).toContainEqual({ symbol: outgoing.symbol, side: 'SELL', quantity: 66, reason: 'REBALANCE_EXIT' });
  expect(next.orders.filter(order => order.side === 'BUY')).toEqual([]);
  expect(result.fills.some(fill => fill.tsMs === buyFillAt && fill.side === 'SELL')).toBe(true);
});

import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { createPaperTradingBroker } from '../../src/server/modules/trading/infrastructure/paper-trading-broker.js';
import { TradingService, type TradingDecisionEngine, type StrategyArtifactStore } from '../../src/server/modules/trading/application/trading-service.js';
import type { TradingSetup } from '../../src/shared/schemas/trading.js';

it('executes the worker decision through the paper service and matches the backtest fill', async () => {
  const p = rangeBreakoutStrategy.parameterSchema.parse({ lookbackBars: 2, atrPeriod: 2, breakoutBufferAtr: 0, minAverageTradingValueKrw: 0, trendSmaBars: 0 });
  const dates = longDays.slice(-5);
  const source = dates.map((tsMs, index) => {
    const close = index < 3 ? 100 : 110;
    return { ...bars[0]!, tsMs, open: close, high: close + 1, low: close - 1, close, volume: index === 3 ? 250 : 10000 };
  });
  const first = dates[3]!, nextOpen = dates[4]!;
  const execution = { cost: { id: 'zero-cost', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 }, slippage: { id: 'zero-slippage', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1, maxVolumeParticipationRate: 0.1 } };
  const backtest = runBacktest(rangeBreakoutStrategy, { candles: source, initialCash: 100000, parameters: p, randomSeed: 1, maxPositions: 1, maxPositionWeightPercent: 100, tradeFromTsMs: first, universeSchedule: [{ fromTsMs: dates[2]!, members: [member] }], execution });
  expect(backtest.fills).toMatchObject([{ symbol: member.symbol, side: 'BUY', quantity: 25, price: 110, commission: 0, tax: 0 }]);
  const database = openDatabase(':memory:');
  const now = nextOpen + 60 * 60 * 1000;
  const marketData = { quotes: async (symbols: string[]) => symbols.map(symbol => ({ symbol, price: 110, timestampMs: now })), dailyCandles: async () => [] };
  const broker = createPaperTradingBroker({ database, marketData, now: () => now });
  const artifacts: StrategyArtifactStore = { list: () => [{ strategyId: rangeBreakoutStrategy.id, name: rangeBreakoutStrategy.name, description: '', artifactHash: 'a'.repeat(64), version: rangeBreakoutStrategy.version, latest: true, executionVersion: '1', parameterSchema: {} }], load: async () => rangeBreakoutStrategy, bundlePath: () => '' };
  const localRuntime = { ...runtime, candles: { getCandlesArray: async (query: { fromTsMs: number; toTsMs: number }) => source.filter(bar => bar.tsMs >= query.fromTsMs && bar.tsMs <= query.toTsMs) }, resolver: { resolveOrDescribeNeeds: async () => ({ kind: 'READY', unionEntries: new Map(), schedule: [{ fromTsMs: dates[2]!, rebalanceDate: day(dates[2]!), members: [member] }], dataExclusions: [], corporateActionExclusions: [] }) } };
  const engine: TradingDecisionEngine = { canTrade: () => true, evaluate: input => calculate({ input, date: day(input.warmupOnly ? dates[2]! : first), bundlePath: '' }, database, { ...bundle, getStrategy: () => rangeBreakoutStrategy } as never, localRuntime as never), close: async () => {} };
  const service = new TradingService({ database, broker, artifacts, engine, now: () => now });
  const config: TradingSetup = { strategyId: rangeBreakoutStrategy.id, artifactHash: 'a'.repeat(64), parameters: p, universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'MONTH', value: 1 } }, timeframe: '1d', budgetKrw: 100000, maxPositions: 1, maxPositionPercent: 100, dailyLossLimitPercent: 5, maxOrderKrw: 100000, maxSlippageBps: 0, randomSeed: 1, sourceJobId: null, paperCommissionProfileId: 'zero-cost', paperSlippageProfileId: 'zero-slippage' };
  try {
    await service.tick();
    await service.register(config, service.snapshot().revision, 'test', 100000);
    await service.activate(service.snapshot().revision, 'test');
    await service.tick();
    await service.refresh();
    expect(service.snapshot().orders).toMatchObject([{ symbol: member.symbol, side: 'BUY', quantity: 25, filledQuantity: 25, averageFillPrice: 110, status: 'FILLED' }]);
    expect(service.snapshot().account?.cashBuyingPower).toBe(97250);
    expect(await broker.holdings('PAPER')).toMatchObject([{ symbol: member.symbol, quantity: 25, marketValue: 2750 }]);
  } finally { await service.close(); database.close(); }
});
