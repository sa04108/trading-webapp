import { describe, expect, it } from 'vitest';
import { UniverseRuleResolver, type UniverseResolveAttempt } from '../../src/runtime/modules/backtest/application/universe-rule-resolver.js';
import { UniverseResolutionAccumulator, mergeUniverseResolutions, partitionRebalanceDates } from '../../src/runtime/modules/backtest/application/universe-resolution-partitions.js';
import { computeRebalanceDates } from '../../src/shared/schemas/rebalance-interval.js';
import type { UniverseRule } from '../../src/shared/schemas/universe-rule.js';

const period = { from: '2024-01-31', to: '2024-04-30' };
const rule: UniverseRule = { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'MONTH', value: 1 } };
const dates = computeRebalanceDates(period, rule.rebalanceInterval);
const ready = (dates: readonly string[]): Extract<UniverseResolveAttempt, { kind: 'READY' }> => ({
  kind: 'READY', schedule: dates.map((rebalanceDate) => ({ rebalanceDate, effectiveDate: rebalanceDate, fromTsMs: 0, members: [], excludedNonTradingCount: 0 })),
  diagnostics: dates.map((rebalanceDate) => ({ rebalanceDate, effectiveDate: rebalanceDate, stages: [] })), unionEntries: new Map(), dataExclusions: [], corporateActionExclusions: [],
});
const needs = (symbol: string, from: string, to: string, known = true): UniverseResolveAttempt => ({ kind: 'NEEDS_DATA', candidateScopeKnown: known, unionEntries: new Map(), needs: { factSymbols: [symbol], actionSymbols: [symbol], priceSymbols: [symbol], selectionMetricDates: [from], priceRange: { from, to } } });

describe('universe resolution partitions', () => {
  it('preserves the month-end anchor and serial result across out-of-order completion', async () => {
    expect(dates).toEqual(['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
    const resolver = new UniverseRuleResolver({
      symbolMaster: { isCovered: () => true, effectiveTradingDateWithinCoverage: (date: string) => date, nonTradingDaysBetween: () => [], getUniverseAsOf: () => new Map() } as never,
      selectionMetrics: { findMissingTradingValueDates: () => [] } as never, candles: {} as never, facts: {} as never, factCoverage: {} as never, actionCoverage: {} as never, logger: {} as never,
    });
    const serial = await resolver.resolveOrDescribeNeeds(rule, period);
    const chunks = partitionRebalanceDates(dates, 2);
    const parts = await Promise.all(chunks.map(async (rebalanceDates) => ({ rebalanceDates, result: await resolver.resolveRebalanceDates(rule, period, rebalanceDates) })));
    expect(mergeUniverseResolutions(parts.reverse(), dates)).toEqual(serial);
    await expect(resolver.resolveRebalanceDates(rule, period, ['2024-03-29'])).rejects.toThrow();
    await expect(resolver.resolveRebalanceDates(rule, period, [dates[1]!, dates[1]!])).rejects.toThrow();
  });
  it('combines all needs and ranges with READY parts', () => {
    const result = mergeUniverseResolutions([
      { rebalanceDates: [dates[2]!, dates[3]!], result: needs('B', '2024-03-01', '2024-04-01', false) },
      { rebalanceDates: [dates[0]!], result: ready([dates[0]!]) },
      { rebalanceDates: [dates[1]!], result: needs('A', '2024-01-01', '2024-02-01') },
    ], dates);
    expect(result).toMatchObject({ kind: 'NEEDS_DATA', candidateScopeKnown: false, needs: { factSymbols: ['A', 'B'], actionSymbols: ['A', 'B'], priceSymbols: ['A', 'B'], selectionMetricDates: ['2024-01-01', '2024-03-01'], priceRange: { from: '2024-01-01', to: '2024-04-01' } } });
  });
  it('deduplicates exclusions and preserves the first entry in date order', () => {
    const a = ready([dates[0]!]); const b = ready(dates.slice(1));
    const exclusion = { symbol: 'X', category: 'KRX_CLASSIFICATION', periodKey: 'p', reason: 'r' } as const;
    const action = { symbol: 'X', year: 2024, periodKey: 'p', reason: 'r', severity: 'BLOCKING' } as const;
    const first = { shortCode: 'X', name: 'first' } as never; const second = { shortCode: 'X', name: 'second' } as never;
    const result = mergeUniverseResolutions([{ rebalanceDates: dates.slice(1), result: { ...b, unionEntries: new Map([['X', second]]), dataExclusions: [exclusion], corporateActionExclusions: [action] } }, { rebalanceDates: [dates[0]!], result: { ...a, unionEntries: new Map([['X', first]]), dataExclusions: [exclusion], corporateActionExclusions: [action] } }], dates);
    expect(result).toMatchObject({ kind: 'READY', dataExclusions: [exclusion], corporateActionExclusions: [action] });
    expect(result.unionEntries.get('X')).toBe(first);
  });
  it('rejects missing, duplicated, foreign, interleaved and mismatched dates', () => {
    expect(() => mergeUniverseResolutions([{ rebalanceDates: dates.slice(1), result: ready(dates.slice(1)) }], dates)).toThrow();
    expect(() => mergeUniverseResolutions([{ rebalanceDates: [dates[0]!, dates[0]!], result: ready([dates[0]!, dates[0]!]) }], dates)).toThrow();
    expect(() => mergeUniverseResolutions([{ rebalanceDates: ['2025-01-01'], result: ready(['2025-01-01']) }], dates)).toThrow();
    expect(() => mergeUniverseResolutions([{ rebalanceDates: [dates[0]!, dates[2]!], result: ready([dates[0]!, dates[2]!]) }], dates)).toThrow();
    expect(() => mergeUniverseResolutions([{ rebalanceDates: dates, result: ready(dates.slice(1)) }], dates)).toThrow();
    expect(() => partitionRebalanceDates(dates, 0)).toThrow();
  });
  it('accumulates many distinct shard maps in order and releases READY data after needs', () => {
    const manyDates = Array.from({ length: 100 }, (_, i) => `date-${String(i).padStart(3, '0')}`);
    const accumulator = new UniverseResolutionAccumulator(manyDates);
    const parts = manyDates.map((date, i) => {
      const result = i === 50 ? needs('B', '2024-01-01', '2024-02-01') : ready([date]);
      return { rebalanceDates: [date], result: { ...result, unionEntries: new Map([['shared', { shortCode: 'shared', name: String(i) } as never], [`key-${i}`, { shortCode: `key-${i}` } as never]]) } };
    });
    expect(() => accumulator.add(parts[1]!)).toThrow();
    for (const part of parts) accumulator.add(part);
    expect(accumulator.finish()).toEqual(mergeUniverseResolutions([...parts].reverse(), manyDates));
    const result = accumulator.finish();
    expect(result.kind).toBe('NEEDS_DATA');
    expect(result.unionEntries.size).toBe(101);
    expect(result.unionEntries.get('shared')).toMatchObject({ name: '0' });
    expect(() => new UniverseResolutionAccumulator(manyDates).finish()).toThrow();
  });

});
