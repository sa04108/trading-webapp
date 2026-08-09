import { z } from 'zod';
import type {
  StrategyBarContext,
  StrategyDecision,
  StrategyInitializeContext,
  TradingStrategy,
} from '../domain/strategy.js';
import {
  isFreshQuarter,
  rankLowPerHighRoe,
  type LowPerHighRoeCandidate,
} from './shared/fundamental-rank.js';
import { planBuyPhase, planSellPhase } from './shared/two-phase-rebalance.js';

export const lowPerHighRoeRankParameters = z.object({
  topN: z.number().int().min(1).max(200).default(40).meta({
    title: '보유 종목 수',
    description: 'PER과 ROE 순위 합이 작은 상위 몇 종목을 동일가중으로 보유할지 정합니다.',
  }),
  staleQuarters: z.number().int().min(0).max(8).default(2).meta({
    title: '허용 공시 지연 (분기)',
    description: '순이익과 자본총계 공시가 뒤처져도 허용할 최대 분기 수입니다.',
  }),
});

export type LowPerHighRoeRankParameters = z.infer<typeof lowPerHighRoeRankParameters>;

export interface LowPerHighRoeRankState {
  readonly symbols: readonly string[];
  pendingBuys: readonly string[] | null;
}

export const lowPerHighRoeRankStrategy: TradingStrategy<
  LowPerHighRoeRankParameters,
  LowPerHighRoeRankState
> = {
  id: 'low-per-high-roe-rank',
  version: '1.0.0',
  name: '저PER·고ROE 순위',
  requiresFundamentals: true,
  description: 'PIT TTM 순이익 기준 저PER과 고ROE를 결합하는 동일가중 연구 전략',
  parameterSchema: lowPerHighRoeRankParameters,
  dataRequirements: {
    fundamentalLookbackQuarters: 4,
    requiresCorporateActions: true,
  },

  initialize(context: StrategyInitializeContext): LowPerHighRoeRankState {
    return { symbols: [...context.symbols], pendingBuys: null };
  },

  onBars(
    context: StrategyBarContext,
    state: LowPerHighRoeRankState,
    parameters: LowPerHighRoeRankParameters,
  ): StrategyDecision {
    if (state.pendingBuys !== null) {
      const orders = planBuyPhase(state.pendingBuys, {
        positions: context.portfolio.positions,
        bars: context.bars,
        equity: context.portfolio.equity,
        topN: parameters.topN,
        tradableSymbols: context.tradableSymbols,
      });
      state.pendingBuys = null;
      return { orders };
    }
    if (!context.isRebalanceBar) return { orders: [] };

    const candidates: LowPerHighRoeCandidate[] = [];
    for (const symbol of state.symbols) {
      if (context.tradableSymbols !== null && !context.tradableSymbols.has(symbol)) continue;
      const metric = context.selectionMetric(symbol);
      if (metric?.marketCapKrw === null || metric?.marketCapKrw === undefined) continue;
      const snapshot = context.fundamentals(symbol);
      if (!snapshot) continue;
      if (
        !isFreshQuarter(snapshot.periodKeyOf('NET_INCOME'), context.tsMs, parameters.staleQuarters)
        || !isFreshQuarter(snapshot.periodKeyOf('TOTAL_EQUITY'), context.tsMs, parameters.staleQuarters)
      ) {
        continue;
      }
      const netIncomeTtm = snapshot.ttm('NET_INCOME');
      const totalEquity = snapshot.get('TOTAL_EQUITY');
      if (netIncomeTtm === null || totalEquity === null) continue;
      candidates.push({ symbol, marketCapKrw: metric.marketCapKrw, netIncomeTtm, totalEquity });
    }

    const targets = rankLowPerHighRoe(candidates)
      .slice(0, parameters.topN)
      .map((candidate) => candidate.symbol);
    const sells = planSellPhase({ targets, positions: context.portfolio.positions });
    const newEntries = targets.filter(
      (symbol) => (context.portfolio.positions.get(symbol)?.quantity ?? 0) <= 0,
    );
    state.pendingBuys = newEntries.length > 0 ? newEntries : null;
    return { orders: sells };
  },
};
