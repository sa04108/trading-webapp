import { z } from 'zod';
import type { FundamentalSnapshot } from '../../facts/domain/fact.js';
import type { Candle } from '../../market-data/domain/candle.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  StrategyInitializeContext,
  TradingStrategy,
} from '../domain/strategy.js';
import { splitAdjustedClose } from './shared/adjusted-price.js';
import {
  combineRanks,
  isFreshQuarter,
  ordinalRank,
  scoreEarningsAcceleration,
  type EarningsAccelerationInput,
} from './shared/fundamental-rank.js';
import { planBuyPhase, planSellPhase } from './shared/two-phase-rebalance.js';

export const earningsAccelerationRankParameters = z.object({
  topN: z.number().int().min(1).max(200).default(40).meta({
    title: '보유 종목 수',
    description: '순위 합이 작은 상위 몇 종목을 동일가중으로 보유할지 정합니다.',
  }),
  priceMomentumDays: z.number().int().min(60).max(252).default(126).meta({
    title: '가격 모멘텀 기간 (봉 수)',
    description: '재무 성장 신호를 확인할 분할보정 가격 수익률 기간입니다.',
  }),
  staleQuarters: z.number().int().min(0).max(8).default(2).meta({
    title: '허용 공시 지연 (분기)',
    description: '영업이익 최신 분기가 현재 분기보다 뒤처져도 허용할 최대 분기 수입니다.',
  }),
});

export type EarningsAccelerationRankParameters = z.infer<typeof earningsAccelerationRankParameters>;

export interface EarningsAccelerationRankState {
  readonly symbols: readonly string[];
  pendingBuys: readonly string[] | null;
}

interface ScoredCandidate {
  readonly symbol: string;
  readonly ttmGrowth: number;
  readonly priceMomentum: number;
}

function priceMomentum(
  history: readonly Candle[],
  actions: ReturnType<StrategyBarContext['corporateActions']>,
  days: number,
): number | null {
  const endIndex = history.length - 1;
  const startIndex = endIndex - days;
  if (startIndex < 0) return null;
  const start = splitAdjustedClose(history, actions, startIndex);
  const end = splitAdjustedClose(history, actions, endIndex);
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || start <= 0) {
    return null;
  }
  const result = end / start - 1;
  return Number.isFinite(result) ? result : null;
}

function earningsInput(
  snapshot: FundamentalSnapshot,
  momentum: number,
): EarningsAccelerationInput | null {
  const quarters = Array.from({ length: 8 }, (_, offset) =>
    snapshot.quarter('OPERATING_INCOME', offset),
  );
  if (quarters.some((quarter) => quarter === null)) return null;
  return {
    q0: quarters[0]!.value,
    q1: quarters[1]!.value,
    q2: quarters[2]!.value,
    q3: quarters[3]!.value,
    q4: quarters[4]!.value,
    q5: quarters[5]!.value,
    q6: quarters[6]!.value,
    q7: quarters[7]!.value,
    priceMomentum: momentum,
  };
}

export const earningsAccelerationRankStrategy: TradingStrategy<
  EarningsAccelerationRankParameters,
  EarningsAccelerationRankState
> = {
  id: 'earnings-acceleration-rank',
  version: '1.0.0',
  name: '이익 가속·가격 확인 순위',
  requiresFundamentals: true,
  description: 'PIT 영업이익 가속과 양의 가격 모멘텀을 함께 순위화하는 동일가중 연구 전략',
  parameterSchema: earningsAccelerationRankParameters,
  dataRequirements: {
    fundamentalLookbackQuarters: 8,
    priceWarmupBars: (parameters) => parameters.priceMomentumDays,
    requiresCorporateActions: true,
  },

  initialize(context: StrategyInitializeContext): EarningsAccelerationRankState {
    return { symbols: [...context.symbols], pendingBuys: null };
  },

  onBars(
    context: StrategyBarContext,
    state: EarningsAccelerationRankState,
    parameters: EarningsAccelerationRankParameters,
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

    const candidates: ScoredCandidate[] = [];
    for (const symbol of state.symbols) {
      if (context.tradableSymbols !== null && !context.tradableSymbols.has(symbol)) continue;
      const snapshot = context.fundamentals(symbol);
      if (!snapshot) continue;
      const latestQuarter = snapshot.quarter('OPERATING_INCOME', 0);
      if (!isFreshQuarter(latestQuarter?.periodKey ?? null, context.tsMs, parameters.staleQuarters)) {
        continue;
      }
      const momentum = priceMomentum(
        context.getHistory(symbol),
        context.corporateActions(symbol),
        parameters.priceMomentumDays,
      );
      if (momentum === null) continue;
      const input = earningsInput(snapshot, momentum);
      if (input === null) continue;
      const score = scoreEarningsAcceleration(input);
      if (score === null) continue;
      candidates.push({ symbol, ...score });
    }

    // 아무도 점수를 못 냈으면(공시 지연·PIT 8분기 미달·모멘텀 계산 불가 등) 이번
    // 리밸런스에서는 기존 보유를 유지한다 — value-quality-rank·low-per-high-roe-rank
    // 의 no-data hold 와 같은 방침이다. 판단 근거가 없으면 보유 유지.
    if (candidates.length === 0) return { orders: [] };

    const growthRanks = ordinalRank(
      candidates,
      (candidate) => candidate.ttmGrowth,
      'DESC',
      (candidate) => candidate.symbol,
    );
    const momentumRanks = ordinalRank(
      candidates,
      (candidate) => candidate.priceMomentum,
      'DESC',
      (candidate) => candidate.symbol,
    );
    const targets = combineRanks(
      candidates,
      [growthRanks, momentumRanks],
      (candidate) => candidate.symbol,
    )
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
