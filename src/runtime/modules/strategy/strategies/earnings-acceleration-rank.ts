import { z } from "zod";
import type { FundamentalSnapshot } from "../../facts/domain/fact.js";
import type { Candle } from "../../market-data/domain/candle.js";
import type {
  StrategyBarContext,
  StrategyDecision,
  StrategyInitializeContext,
  TradingStrategy,
} from "../domain/strategy.js";
import { splitAdjustedClose } from "./shared/adjusted-price.js";
import {
  combineRanks,
  isFreshQuarter,
  ordinalRank,
  scoreEarningsAcceleration,
  type EarningsAccelerationInput,
} from "./shared/fundamental-rank.js";
import { beginRankCycle, finishRankCycle, newRankRiskState, rankLiquidityReady, rankPriceWarmup, rankRiskParameters, type RankRiskState } from "./shared/rank-risk.js";

export const earningsAccelerationRankParameters = rankRiskParameters.extend({
  topN: z.number().int().min(1).max(200).default(40).meta({
    title: "보유 종목 수",
    description:
      "순위 합이 작은 상위 몇 종목을 동일가중으로 보유할지 정합니다.",
  }),
  priceMomentumDays: z.number().int().min(60).max(252).default(126).meta({
    title: "가격 모멘텀 기간 (봉 수)",
    description: "재무 성장 신호를 확인할 분할보정 가격 수익률 기간입니다.",
  }),
  priceMomentumSkipDays: z.number().int().min(0).max(63).default(21).meta({
    title: "최근 가격 제외 기간 (거래일)",
    description: "가격 확인에서 최근 급등락 구간을 제외합니다. 공시는 실제 공개 시점 이후의 자료만 사용하며 공시 시각을 앞당기지 않습니다.",
  }),
  staleQuarters: z.number().int().min(1).max(8).default(2).meta({
    title: "허용 공시 지연 (분기)",
    description:
      "영업이익 최신 분기가 현재 분기보다 뒤처져도 허용할 최대 분기 수입니다.",
  }),
});

export type EarningsAccelerationRankParameters = z.infer<
  typeof earningsAccelerationRankParameters
>;

export type EarningsAccelerationRankState = RankRiskState;

interface ScoredCandidate {
  readonly symbol: string;
  readonly ttmGrowth: number;
  readonly priceMomentum: number;
}

function priceMomentum(
  history: readonly Candle[],
  actions: ReturnType<StrategyBarContext["corporateActions"]>,
  days: number,
  skipDays: number,
): number | null {
  const endIndex = history.length - 1 - skipDays;
  const startIndex = endIndex - days;
  if (startIndex < 0) return null;
  const start = splitAdjustedClose(history, actions, startIndex);
  const end = splitAdjustedClose(history, actions, endIndex);
  if (
    start === null ||
    end === null ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start <= 0
  ) {
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
    snapshot.quarter("OPERATING_INCOME", offset),
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
  id: "earnings-acceleration-rank",
  version: "2.0.0",
  name: "이익 가속·가격 확인 순위",
  requiresFundamentals: true,
  description:
    "공시 시점의 8분기 영업이익으로 성장·가속을 확인하고 최근 급등락을 제외한 가격 모멘텀을 결합합니다. 코스피 추세에 따라 투자 비중을 줄이고 순위 교체를 완충합니다.",
  parameterSchema: earningsAccelerationRankParameters,
  historyLookbackBars: (parameters) => Math.max(rankPriceWarmup(parameters), parameters.priceMomentumDays + parameters.priceMomentumSkipDays + 1),
  requiredRebalanceGapBars: 1,
  dataRequirements: {
    marketIndexBars: (parameters) => parameters.marketTrendBars,
    fundamentalFields: ["OPERATING_INCOME"],
    fundamentalLookbackQuarters: 8,
    fundamentalsReady: (snapshot, tsMs, parameters) => {
      const quarters = Array.from({ length: 8 }, (_, offset) =>
        snapshot.quarter("OPERATING_INCOME", offset),
      );
      return (
        quarters.every((quarter) => quarter !== null) &&
        isFreshQuarter(
          quarters[0]?.periodKey ?? null,
          tsMs,
          parameters.staleQuarters,
        )
      );
    },
    priceWarmupBars: (parameters) => Math.max(rankPriceWarmup(parameters), parameters.priceMomentumDays + parameters.priceMomentumSkipDays + 1),
    requiresCorporateActions: true,
  },

  initialize(
    context: StrategyInitializeContext,
  ): EarningsAccelerationRankState {
    return newRankRiskState(context.symbols);
  },

  onBars(
    context: StrategyBarContext,
    state: EarningsAccelerationRankState,
    parameters: EarningsAccelerationRankParameters,
  ): StrategyDecision {
    const phase = beginRankCycle(context, state, parameters);
    if (phase !== null) return phase;

    const candidates: ScoredCandidate[] = [];
    let evaluated = 0;
    for (const symbol of state.symbols) {
      if (
        context.tradableSymbols !== null &&
        !context.tradableSymbols.has(symbol)
      )
        continue;
      const snapshot = context.fundamentals(symbol);
      if (!snapshot) continue;
      const latestQuarter = snapshot.quarter("OPERATING_INCOME", 0);
      if (
        !isFreshQuarter(
          latestQuarter?.periodKey ?? null,
          context.tsMs,
          parameters.staleQuarters,
        )
      ) {
        continue;
      }
      const momentum = priceMomentum(
        context.getHistory(symbol),
        context.corporateActions(symbol),
        parameters.priceMomentumDays,
        parameters.priceMomentumSkipDays,
      );
      if (momentum === null) continue;
      const input = earningsInput(snapshot, momentum);
      if (input === null) continue;
      evaluated++;
      if (!rankLiquidityReady(context, symbol, parameters)) continue;
      const score = scoreEarningsAcceleration(input);
      if (score === null) continue;
      candidates.push({ symbol, ...score });
    }

    // 입력 자체가 없을 때만 기존 보유를 유지한다. 평가했지만 성장·모멘텀·유동성
    // 자격을 모두 잃은 경우에는 빈 목표를 적용해 현금으로 전환한다.
    if (evaluated === 0) return { orders: [] };

    const growthRanks = ordinalRank(
      candidates,
      (candidate) => candidate.ttmGrowth,
      "DESC",
      (candidate) => candidate.symbol,
      context.rng,
    );
    const momentumRanks = ordinalRank(
      candidates,
      (candidate) => candidate.priceMomentum,
      "DESC",
      (candidate) => candidate.symbol,
      context.rng,
    );
    const targets = combineRanks(
      candidates,
      [growthRanks, momentumRanks],
      (candidate) => candidate.symbol,
      context.rng,
    )
      .map((candidate) => candidate.symbol);

    return finishRankCycle(targets, context, state, parameters);
  },
};
