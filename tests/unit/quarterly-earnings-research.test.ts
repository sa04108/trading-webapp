import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/server/modules/backtest/domain/seeded-rng.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import { createQuarterlyEarnings, hasEightQuarters, quarterlySnapshot, type QuarterObservation } from '../../scripts/quarter-research/quarterly-earnings.js';

const available = '2026-03-21';
const tsMs = Date.parse(available);
const rows: QuarterObservation[] = [40, 30, 20, 10, 20, 20, 20, 20].map((value, i) => {
  const ordinal = 2025 * 4 + 3 - i;
  return { symbol: 'A', periodKey: `${Math.floor(ordinal / 4)}Q${ordinal % 4 + 1}`, ordinal,
    basis: 'CFS', value, asof: '2026-03-20', available, receipts: ['20260320000000'], method: 'test' };
});

describe('연구용 분기 실적 입력', () => {
  it('공개일 다음 날 전에는 정정된 과거 분기와 최신 분기를 노출하지 않는다', () => {
    expect(quarterlySnapshot(rows, Date.parse('2026-03-20'))).toBeNull();
    const snapshot = quarterlySnapshot(rows, tsMs);
    expect(hasEightQuarters(snapshot, tsMs)).toBe(true);
    expect(snapshot?.ttm('OPERATING_INCOME')).toBe(100);
    expect(snapshot?.ttm('OPERATING_INCOME', 4)).toBe(80);
    expect(snapshot?.get('NET_INCOME')).toBeNull();
  });

  it('연결의 누락 분기를 별도로 채우거나 더 오래된 분기로 당기지 않는다', () => {
    const mixed = rows.map((r, i) => i === 3 ? { ...r, basis: 'OFS' as const } : r);
    const snapshot = quarterlySnapshot(mixed, tsMs);
    expect(snapshot?.quarter('OPERATING_INCOME', 3)).toBeNull();
    expect(snapshot?.quarter('OPERATING_INCOME', 4)?.value).toBe(20);
    expect(snapshot?.ttm('OPERATING_INCOME')).toBeNull();
    expect(hasEightQuarters(snapshot, tsMs)).toBe(false);
  });

  it('최신 연결 공시가 없으면 연속된 별도 기준을 쓰되 오래된 실적은 준비 완료로 보지 않는다', () => {
    const separate = rows.map((r) => ({ ...r, basis: 'OFS' as const }));
    expect(hasEightQuarters(quarterlySnapshot(separate, tsMs), tsMs)).toBe(true);
    expect(hasEightQuarters(quarterlySnapshot(rows, Date.parse('2027-01-01')), Date.parse('2027-01-01'))).toBe(false);
  });

  it('아직 공개되지 않은 새 분기는 최신 분기와 순위를 바꾸지 않는다', () => {
    const future = { ...rows[0]!, ordinal: 2026 * 4, periodKey: '2026Q1', available: '2026-05-16', asof: '2026-05-15', value: 9999 };
    expect(quarterlySnapshot([...rows, future], tsMs)?.latestPeriodKey).toBe('2025Q4');
    expect(quarterlySnapshot([...rows, future], Date.parse('2026-05-16'))?.latestPeriodKey).toBe('2026Q1');
  });

  it('기존 이익 가속 전략에서 공개 전에는 주문하지 않고 공개 후 두 단계로 매수를 계획한다', () => {
    const history: Candle[] = Array.from({ length: 61 }, (_, i) => ({ symbol: 'A', market: 'KR', timeframe: '1d',
      tsMs: tsMs - (60 - i) * 86_400_000, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1000 }));
    const strategy = createQuarterlyEarnings(rows);
    const p = strategy.parameterSchema.parse({ topN: 1, priceMomentumDays: 60 });
    const rng = createRng(204);
    const state = strategy.initialize({ symbols: ['A'], initialCash: 10000, rng });
    const context: StrategyBarContext = { tsMs: tsMs - 86_400_000, isRebalanceBar: true, bars: new Map([['A', history.at(-1)!]]),
      getHistory: () => history, portfolio: { cash: 10000, equity: 10000, positions: new Map() }, rng,
      fundamentals: () => { throw new Error('검증되지 않은 기존 재무 입력은 호출하면 안 된다'); }, corporateActions: () => [],
      tradableSymbols: new Set(['A']), activeUniverseSymbols: new Set(['A']), selectionMetric: () => null };
    expect(strategy.onBars(context, state, p).orders).toEqual([]);
    expect(state.pendingTargets).toBeNull();
    expect(strategy.onBars({ ...context, tsMs }, state, p).orders).toEqual([]);
    expect(state.pendingTargets).toEqual(['A']);
    const decision = strategy.onBars({ ...context, tsMs: tsMs + 86_400_000, isRebalanceBar: false }, state, p);
    expect(decision.orders).toHaveLength(1);
    expect(decision.orders[0]).toMatchObject({ symbol: 'A', side: 'BUY' });
  });
});
