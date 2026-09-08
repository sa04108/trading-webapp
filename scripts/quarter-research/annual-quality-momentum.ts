import { z } from 'zod';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';
import { crossSectionalMomentumStrategy, type CrossSectionalMomentumState } from '../../src/server/modules/strategy/strategies/cross-sectional-momentum.js';
import type { MacroPoint } from './quarter-engine.js';

export interface AnnualObservation {
  code: string;
  year: number;
  basis: string;
  receipt: string;
  asof: string;
  operating_income: number;
  equity: number;
}

export const annualQualityParameters = z.object({
  formationDays: z.number().int().min(20).max(120).default(60),
  minGrowth: z.number().min(0).max(1).default(.15),
  minOperatingReturnOnEquity: z.number().min(0).max(1).default(.10),
  topN: z.number().int().min(2).max(10).default(5),
});
type Parameters = z.infer<typeof annualQualityParameters>;

/** 정정 공시의 현재 값도 반환된 접수일 다음 날 이후에만 사용한다. */
export function annualQuality(rows: readonly AnnualObservation[], tsMs: number, p: Parameters) {
  const known = rows.filter((r) => Date.parse(r.asof) + 86_400_000 <= tsMs);
  const year = Math.max(...known.map((r) => r.year));
  const available = known.filter((r) => r.year === year);
  const current = available.find((r) => r.basis === 'CFS') ?? available.find((r) => r.basis === 'OFS');
  if (!current || tsMs - Date.parse(current.asof) > 540 * 86_400_000) return null;
  const previous = known.find((r) => r.year === year - 1 && r.basis === current.basis);
  if (!previous || current.equity <= 0 || previous.operating_income <= 0 || current.operating_income <= 0) return null;
  const growth = current.operating_income / previous.operating_income - 1;
  const profitability = current.operating_income / current.equity;
  if (growth < p.minGrowth || profitability < p.minOperatingReturnOnEquity) return null;
  return { year, basis: current.basis, receipt: current.receipt, asof: current.asof, growth, profitability };
}

interface State {
  momentum: CrossSectionalMomentumState;
  exiting: Set<string>;
}

/** 연간 이익 성장과 자본 대비 영업이익을 통과한 종목에 기존 모멘텀을 적용한다. */
export function createAnnualQualityMomentum(observations: readonly AnnualObservation[], macro: ReadonlyMap<number, MacroPoint>): TradingStrategy<Parameters, State> {
  const bySymbol = new Map<string, AnnualObservation[]>();
  for (const row of observations) {
    const rows = bySymbol.get(row.code) ?? [];
    rows.push(row);
    bySymbol.set(row.code, rows);
  }
  return {
    id: 'annual-quality-momentum', version: '0.1.0', name: '연간 실적 성장 모멘텀 (연구)',
    description: '공개된 같은 회계기준의 연간 이익 성장·자본 대비 영업이익과 가격 모멘텀을 결합하는 연구 후보',
    parameterSchema: annualQualityParameters, requiredRebalanceGapBars: 1,
    dataRequirements: { priceWarmupBars: (p) => p.formationDays + 1, requiresCorporateActions: true },
    initialize: (context) => ({ momentum: crossSectionalMomentumStrategy.initialize(context), exiting: new Set() }),
    onBars(context, state, p) {
      const m = macro.get(context.tsMs);
      const open = m !== undefined && (m.kospi > m.kospiSma20 || m.kospi > m.kospiSma60)
        && m.kospiRet20 > -.05 && m.vix < 35 && !(m.oilRet20 > .20 && m.fxRet20 > .03);
      const symbols = context.tradableSymbols ?? new Set(state.momentum.symbols);
      const qualified = new Set(open ? [...symbols].filter((s) => annualQuality(bySymbol.get(s) ?? [], context.tsMs, p) !== null) : []);
      const decision = crossSectionalMomentumStrategy.onBars({ ...context, tradableSymbols: qualified }, state.momentum,
        { formationDays: p.formationDays, skipDays: 0, topN: p.topN, absoluteMomentumFilter: true });
      for (const s of state.exiting) if (!context.portfolio.positions.has(s)) state.exiting.delete(s);
      if (open) return decision;
      state.momentum.pendingTargets = null;
      const orders = [];
      for (const position of context.portfolio.positions.values()) {
        if (state.exiting.has(position.symbol)) continue;
        state.exiting.add(position.symbol);
        orders.push({ symbol: position.symbol, side: 'SELL' as const, quantity: position.quantity, reason: '실적 전략 시장 조건 이탈' });
      }
      return { orders };
    },
  };
}
