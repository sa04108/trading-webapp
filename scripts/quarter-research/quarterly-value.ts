import type { FundamentalField, FundamentalSnapshot } from '../../src/server/modules/facts/domain/fact.js';
import { lowPerHighRoeRankStrategy } from '../../src/server/modules/strategy/strategies/low-per-high-roe-rank.js';
import type { QuarterObservation } from './quarterly-earnings.js';

export interface ValuationObservation extends QuarterObservation {
  field: 'NET_INCOME' | 'TOTAL_EQUITY';
}
export interface CapitalizationPoint {
  tsMs: number;
  asof: string;
  values: Record<string, string>;
}

/** 최신 보고서의 회계기준 하나 안에서 각 계정의 실제 공개 분기를 찾는다. */
export function valuationSnapshot(rows: readonly ValuationObservation[], tsMs: number): FundamentalSnapshot | null {
  const known = rows.filter((r) => Date.parse(r.available) <= tsMs);
  if (known.length === 0) return null;
  const latestOrdinal = Math.max(...known.map((r) => r.ordinal));
  const basis = known.some((r) => r.ordinal === latestOrdinal && r.basis === 'CFS') ? 'CFS' : 'OFS';
  const sameBasis = known.filter((r) => r.basis === basis);
  const fields = new Map<FundamentalField, Map<number, ValuationObservation>>();
  for (const row of sameBasis) {
    const quarters = fields.get(row.field) ?? new Map<number, ValuationObservation>();
    quarters.set(row.ordinal, row);
    fields.set(row.field, quarters);
  }
  const latest = new Map([...fields].map(([field, quarters]) => [field, Math.max(...quarters.keys())]));
  const quarter = (field: FundamentalField, offset = 0) => {
    const ordinal = latest.get(field);
    if (ordinal === undefined || !Number.isInteger(offset) || offset < 0) return null;
    const row = fields.get(field)?.get(ordinal - offset);
    return row ? { periodKey: row.periodKey, value: row.value } : null;
  };
  return {
    get: (field) => quarter(field)?.value ?? null,
    quarter,
    ttm(field, endOffset = 0) {
      if (field !== 'NET_INCOME') return null;
      const parts = Array.from({ length: 4 }, (_, i) => quarter(field, endOffset + i));
      return parts.some((r) => r === null) ? null : parts.reduce((sum, r) => sum + r!.value, 0);
    },
    periodKeyOf: (field) => quarter(field)?.periodKey ?? null,
    latestPeriodKey: sameBasis.find((r) => r.ordinal === latestOrdinal)!.periodKey,
    latestAsOfTsMs: Math.max(...sameBasis.filter((r) => r.ordinal === latestOrdinal).map((r) => Date.parse(r.asof))),
  };
}

/** 확정 종가 시가총액과 검증한 재무 입력을 기존 저PER·고ROE 전략에 연결한다. */
export function createQuarterlyValue(observations: readonly ValuationObservation[], capitalizations: readonly CapitalizationPoint[]) {
  const bySymbol = new Map<string, ValuationObservation[]>();
  for (const row of observations) {
    const list = bySymbol.get(row.symbol) ?? [];
    list.push(row);
    bySymbol.set(row.symbol, list);
  }
  const caps = new Map(capitalizations.map((p) => {
    if (!Number.isFinite(Date.parse(p.asof)) || !Number.isFinite(p.tsMs) || Date.parse(p.asof) > p.tsMs) throw new Error('시가총액의 공개 날짜가 신호일보다 늦습니다');
    return [p.tsMs, p.values] as const;
  }));
  return {
    ...lowPerHighRoeRankStrategy,
    id: 'low-per-quarterly-research', version: `0.1.0+low-per-${lowPerHighRoeRankStrategy.version}`,
    onBars(context: Parameters<typeof lowPerHighRoeRankStrategy.onBars>[0],
      state: Parameters<typeof lowPerHighRoeRankStrategy.onBars>[1],
      parameters: Parameters<typeof lowPerHighRoeRankStrategy.onBars>[2]) {
      return lowPerHighRoeRankStrategy.onBars({ ...context,
        fundamentals: (symbol) => valuationSnapshot(bySymbol.get(symbol) ?? [], context.tsMs),
        selectionMetric: (symbol) => ({ marketCapKrw: caps.get(context.tsMs)?.[symbol] ?? null,
          volume: context.bars.get(symbol)?.volume ?? null, tradingValueKrw: null }),
      }, state, parameters);
    },
  };
}
