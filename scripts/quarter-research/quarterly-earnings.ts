import type { FundamentalField, FundamentalSnapshot } from '../../src/server/modules/facts/domain/fact.js';
import { earningsAccelerationRankStrategy } from '../../src/server/modules/strategy/strategies/earnings-acceleration-rank.js';
import { isFreshQuarter } from '../../src/server/modules/strategy/strategies/shared/fundamental-rank.js';

export interface QuarterObservation {
  symbol: string;
  periodKey: string;
  ordinal: number;
  basis: 'CFS' | 'OFS';
  value: number;
  asof: string;
  available: string;
  receipts: string[];
  method: string;
}

/** 최신 공개 분기의 회계기준 하나를 선택하고 빠진 과거 분기를 다른 기준으로 메우지 않는다. */
export function quarterlySnapshot(rows: readonly QuarterObservation[], tsMs: number): FundamentalSnapshot | null {
  const known = rows.filter((r) => Date.parse(r.available) <= tsMs);
  if (known.length === 0) return null;
  const ordinal = Math.max(...known.map((r) => r.ordinal));
  const latest = known.find((r) => r.ordinal === ordinal && r.basis === 'CFS')
    ?? known.find((r) => r.ordinal === ordinal && r.basis === 'OFS');
  if (!latest) return null;
  const quarters = new Map(known.filter((r) => r.basis === latest.basis).map((r) => [r.ordinal, r]));
  const quarter = (field: FundamentalField, offset = 0) => {
    if (field !== 'OPERATING_INCOME' || !Number.isInteger(offset) || offset < 0) return null;
    const r = quarters.get(ordinal - offset);
    return r ? { periodKey: r.periodKey, value: r.value } : null;
  };
  return {
    get: (field) => quarter(field)?.value ?? null,
    quarter,
    ttm(field, endOffset = 0) {
      const values = Array.from({ length: 4 }, (_, i) => quarter(field, endOffset + i));
      return values.some((r) => r === null) ? null : values.reduce((sum, r) => sum + r!.value, 0);
    },
    periodKeyOf: (field) => field === 'OPERATING_INCOME' ? latest.periodKey : null,
    latestPeriodKey: latest.periodKey,
    latestAsOfTsMs: Date.parse(latest.asof),
  };
}

export function hasEightQuarters(snapshot: FundamentalSnapshot | null, tsMs: number, staleQuarters = 2): boolean {
  return snapshot !== null && isFreshQuarter(snapshot.latestPeriodKey, tsMs, staleQuarters)
    && Array.from({ length: 8 }, (_, i) => snapshot.quarter('OPERATING_INCOME', i)).every((r) => r !== null);
}

/** 검증된 분기 입력만 교체하고 기존 이익 가속 전략의 순위·매매 로직을 그대로 사용한다. */
export function createQuarterlyEarnings(observations: readonly QuarterObservation[]) {
  const bySymbol = new Map<string, QuarterObservation[]>();
  for (const row of observations) {
    const rows = bySymbol.get(row.symbol) ?? [];
    rows.push(row);
    bySymbol.set(row.symbol, rows);
  }
  return {
    ...earningsAccelerationRankStrategy,
    id: 'quarterly-earnings-research', version: `0.1.0+earnings-${earningsAccelerationRankStrategy.version}`,
    onBars(context: Parameters<typeof earningsAccelerationRankStrategy.onBars>[0],
      state: Parameters<typeof earningsAccelerationRankStrategy.onBars>[1],
      parameters: Parameters<typeof earningsAccelerationRankStrategy.onBars>[2]) {
      return earningsAccelerationRankStrategy.onBars({ ...context,
        fundamentals: (symbol) => quarterlySnapshot(bySymbol.get(symbol) ?? [], context.tsMs),
      }, state, parameters);
    },
  };
}
