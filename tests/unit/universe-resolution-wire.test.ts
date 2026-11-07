import { describe, expect, it } from 'vitest';
import { decodeUniverseResolution, encodeUniverseResolution } from '../../src/runtime/modules/backtest/application/universe-resolution-wire.js';
import type { UniverseResolveAttempt } from '../../src/runtime/modules/backtest/application/universe-rule-resolver.js';

const entry = { shortCode: '000001', standardCode: 'KR7000000001', name: '종목', market: 'KOSPI', sharesOutstanding: '9007199254740993', instrumentType: 'COMMON_STOCK', listedDate: null } as const;
const ready: UniverseResolveAttempt = { kind: 'READY', unionEntries: new Map([[entry.shortCode, entry]]), schedule: [{ rebalanceDate: '2024-01-31', effectiveDate: '2024-01-30', fromTsMs: Date.parse('2024-01-31T00:00:00Z'), members: [{ symbol: entry.shortCode, standardCode: entry.standardCode, marketCapKrw: '9007199254740993', volume: null, tradingValueKrw: '7' }], excludedNonTradingCount: 0 }], diagnostics: [{ rebalanceDate: '2024-01-31', effectiveDate: '2024-01-30', stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', inputCount: 1, eligibleCount: 1, selectedCount: 1, excludedMissingCount: 0 }] }], dataExclusions: [{ symbol: entry.shortCode, category: 'KRX_PRICE', periodKey: '2024', reason: '누락' }], corporateActionExclusions: [{ symbol: entry.shortCode, year: 2024, periodKey: '2024', reason: '누락', severity: 'BLOCKING' }] };
const needs: UniverseResolveAttempt = { kind: 'NEEDS_DATA', unionEntries: new Map([[entry.shortCode, entry]]), candidateScopeKnown: false, needs: { factSymbols: ['000002', '000001'], actionSymbols: ['000001'], priceSymbols: ['000001'], selectionMetricDates: ['2024-01-31'], priceRange: { from: '2023-01-01', to: '2024-01-31' } } };

describe('universe resolution wire format', () => {
  it('round trips READY and NEEDS_DATA with map ordering and exact metric strings', () => {
    for (const result of [ready, needs]) expect(decodeUniverseResolution(encodeUniverseResolution(result))).toEqual(result);
  });
  it('preserves extra exclusion fields', () => {
    const value = JSON.parse(encodeUniverseResolution(ready));
    value.corporateActionExclusions[0].detail = '원문';
    expect(decodeUniverseResolution(JSON.stringify(value))).toMatchObject({ corporateActionExclusions: [{ detail: '원문' }] });
  });
  it('rejects duplicate map entries, invalid fields, excessive results and oversized JSON', () => {
    const value = JSON.parse(encodeUniverseResolution(ready));
    value.unionEntries.push(value.unionEntries[0]);
    expect(() => decodeUniverseResolution(JSON.stringify(value))).toThrow();
    value.unionEntries.pop();
    value.schedule[0].members[0].volume = 'not a number';
    expect(() => decodeUniverseResolution(JSON.stringify(value))).toThrow();
    value.schedule[0].members[0].volume = null;
    value.schedule[0].members = Array(201).fill(value.schedule[0].members[0]);
    expect(() => decodeUniverseResolution(JSON.stringify(value))).toThrow();
    expect(() => decodeUniverseResolution(' '.repeat(8 * 1024 * 1024 + 1))).toThrow();
  });
  it('rejects forged dates, inconsistent identities and impossible diagnostics', () => {
    const original = JSON.parse(encodeUniverseResolution(ready)) as { schedule: { fromTsMs: number; effectiveDate: string; members: { standardCode: string }[] }[]; diagnostics: { effectiveDate: string; stages: { eligibleCount: number }[] }[] };
    const rejected = (mutate: (value: typeof original) => void) => {
      const value = structuredClone(original); mutate(value);
      expect(() => decodeUniverseResolution(JSON.stringify(value))).toThrow();
    };
    rejected((v) => { v.schedule[0]!.fromTsMs += 1; });
    rejected((v) => { v.schedule[0]!.effectiveDate = '2024-02-01'; });
    rejected((v) => { v.diagnostics[0]!.effectiveDate = '2024-01-29'; });
    rejected((v) => { v.schedule[0]!.members.push(v.schedule[0]!.members[0]!); });
    rejected((v) => { v.schedule[0]!.members[0]!.standardCode = 'wrong'; });
    rejected((v) => { v.diagnostics[0]!.stages[0]!.eligibleCount = 2; });
  });

});
