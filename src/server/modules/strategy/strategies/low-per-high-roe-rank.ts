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
  staleQuarters: z.number().int().min(1).max(8).default(2).meta({
    title: '허용 공시 지연 (분기)',
    description: '순이익과 자본총계 공시가 뒤처져도 허용할 최대 분기 수입니다.',
  }),
});

export type LowPerHighRoeRankParameters = z.infer<typeof lowPerHighRoeRankParameters>;

export interface LowPerHighRoeRankState {
  readonly symbols: readonly string[];
  pendingTargets: readonly string[] | null;
}

export const lowPerHighRoeRankStrategy: TradingStrategy<
  LowPerHighRoeRankParameters,
  LowPerHighRoeRankState
> = {
  id: 'low-per-high-roe-rank',
  version: '1.2.2',
  name: '저PER·고ROE 순위',
  requiresFundamentals: true,
  description: 'PIT TTM 순이익 기준 저PER과 고ROE를 결합하는 동일가중 연구 전략',
  parameterSchema: lowPerHighRoeRankParameters,
  requiredRebalanceGapBars: 1,
  dataRequirements: {
    fundamentalLookbackQuarters: 4,
    requiresCorporateActions: true,
  },

  initialize(context: StrategyInitializeContext): LowPerHighRoeRankState {
    return { symbols: [...context.symbols], pendingTargets: null };
  },

  onBars(
    context: StrategyBarContext,
    state: LowPerHighRoeRankState,
    parameters: LowPerHighRoeRankParameters,
  ): StrategyDecision {
    if (state.pendingTargets !== null) {
      const orders = planBuyPhase(state.pendingTargets, {
        positions: context.portfolio.positions,
        bars: context.bars,
        equity: context.portfolio.equity,
        topN: parameters.topN,
        tradableSymbols: context.tradableSymbols,
      });
      state.pendingTargets = null;
      return { orders };
    }
    if (!context.isRebalanceBar) return { orders: [] };

    // 레거시 symbols-only 일정은 selectionMetric pin 이 전혀 없다(전부 null). 그대로
    // 진행하면 후보 0 → 목표 0 → 전량 청산이 매 리밸런스 반복된다. 판단 근거가
    // 없으면 보유를 유지한다 — value-quality-rank 의 no-data hold 와 같은 방침이다.
    if (state.symbols.every((symbol) => context.selectionMetric(symbol) === null)) {
      return { orders: [] };
    }

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

    // 선정지표는 있어도 필수 재무 팩트가 전부 누락·stale이면 새 목표를
    // 정할 근거가 없다. 빈 목표로 기존 보유를 전량 매도하지 않고 이번 리밸런스를 건너뛴다.
    if (candidates.length === 0) return { orders: [] };

    const targets = rankLowPerHighRoe(candidates, context.rng)
      .slice(0, parameters.topN)
      .map((candidate) => candidate.symbol);
    const sells = planSellPhase({
      targets,
      positions: context.portfolio.positions,
      bars: context.bars,
      equity: context.portfolio.equity,
      topN: parameters.topN,
    });
    state.pendingTargets = targets.length > 0 ? targets : null;
    return { orders: sells };
  },
};
