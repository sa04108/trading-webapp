import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/server/modules/backtest/domain/seeded-rng.js';
import type { StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { createQuarterlyValue, valuationSnapshot, type ValuationObservation } from '../../scripts/quarter-research/quarterly-value.js';
import { lowPerHighRoeRankStrategy } from '../../src/server/modules/strategy/strategies/low-per-high-roe-rank.js';

const tsMs = Date.parse('2026-03-21');
const income: ValuationObservation[] = [40, 30, 20, 10].map((value, i) => {
  const ordinal = 2025 * 4 + 3 - i;
  return { symbol: 'A', field: 'NET_INCOME', periodKey: `${Math.floor(ordinal / 4)}Q${ordinal % 4 + 1}`, ordinal,
    basis: 'CFS', value, asof: '2026-03-20', available: '2026-03-21', receipts: ['20260320000000'], method: 'test' };
});
const equity: ValuationObservation = { ...income[0]!, field: 'TOTAL_EQUITY', value: 500 };
const p = lowPerHighRoeRankStrategy.parameterSchema.parse({});

describe('저PER 연구 입력의 회계기준·공개시점', () => {
  it('공개 다음 날부터 TTM 순이익과 기말 자본을 기존 전략에 제공한다', () => {
    expect(valuationSnapshot([...income, equity], tsMs - 86_400_000)).toBeNull();
    const snapshot = valuationSnapshot([...income, equity], tsMs)!;
    expect(snapshot.ttm('NET_INCOME')).toBe(100);
    expect(snapshot.get('TOTAL_EQUITY')).toBe(500);
    expect(snapshot.ttm('TOTAL_EQUITY')).toBeNull();
    expect(lowPerHighRoeRankStrategy.dataRequirements!.fundamentalsReady!(snapshot, tsMs, p)).toBe(true);
  });

  it('연결 순이익의 빈 분기를 별도 순이익으로 채우지 않는다', () => {
    const mixed = income.map((r, i) => i === 2 ? { ...r, basis: 'OFS' as const } : r);
    const snapshot = valuationSnapshot([...mixed, equity], tsMs)!;
    expect(snapshot.ttm('NET_INCOME')).toBeNull();
    expect(lowPerHighRoeRankStrategy.dataRequirements!.fundamentalsReady!(snapshot, tsMs, p)).toBe(false);
  });

  it('자본만 갱신돼도 오래된 순이익의 분기와 신선도를 유지한다', () => {
    const newer = { ...equity, ordinal: 2026 * 4 + 3, periodKey: '2026Q4', asof: '2027-03-20', available: '2027-03-21' };
    const snapshot = valuationSnapshot([...income, equity, newer], Date.parse('2027-03-21'))!;
    expect(snapshot.periodKeyOf('NET_INCOME')).toBe('2025Q4');
    expect(snapshot.periodKeyOf('TOTAL_EQUITY')).toBe('2026Q4');
    expect(lowPerHighRoeRankStrategy.dataRequirements!.fundamentalsReady!(snapshot, Date.parse('2027-03-21'), p)).toBe(false);
  });

  it('실제 기존 전략은 연결된 시가총액·순이익·자본 순위로 목표를 정하고 다음 단계에서 매수한다', () => {
    const other = [...income, equity].map((r) => ({ ...r, symbol: 'B', value: r.field === 'TOTAL_EQUITY' ? 1000 : r.value }));
    const strategy = createQuarterlyValue([...income, equity, ...other], [{ tsMs, asof: '2026-03-21', values: { A: '1000', B: '2000' } }]);
    const rng = createRng(204);
    const state = strategy.initialize({ symbols: ['A', 'B'], initialCash: 10000, rng });
    const parameters = strategy.parameterSchema.parse({ topN: 1 });
    const bars = new Map(['A', 'B'].map((symbol) => [symbol, { symbol, market: 'KR', timeframe: '1d', tsMs, open: 100,
      high: 100, low: 100, close: 100, volume: 10000 } as Candle]));
    const context: StrategyBarContext = { tsMs, isRebalanceBar: true, bars, getHistory: (symbol) => [bars.get(symbol)!],
      portfolio: { cash: 10000, equity: 10000, positions: new Map() }, rng,
      fundamentals: () => { throw new Error('외부 재무 입력을 읽으면 안 된다'); },
      selectionMetric: () => { throw new Error('외부 시가총액을 읽으면 안 된다'); },
      corporateActions: () => [], tradableSymbols: new Set(['A', 'B']), activeUniverseSymbols: new Set(['A', 'B']) };
    expect(strategy.onBars(context, state, parameters).orders).toEqual([]);
    expect(state.pendingTargets).toEqual(['A']);
    expect(strategy.onBars({ ...context, tsMs: tsMs + 86_400_000, isRebalanceBar: false }, state, parameters).orders)
      .toEqual([expect.objectContaining({ symbol: 'A', side: 'BUY' })]);
  });

  it('미래 날짜의 시가총액을 현재 신호에 연결하면 중단한다' , () => {
    expect(() => createQuarterlyValue([...income, equity], [{ tsMs, asof: '2026-03-22', values: { A: '1000' } }])).toThrow('신호일보다 늦습니다');
  });
});
