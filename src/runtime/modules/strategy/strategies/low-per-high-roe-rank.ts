import { z } from "zod";
import type {
  StrategyBarContext,
  StrategyDecision,
  StrategyInitializeContext,
  TradingStrategy,
} from "../domain/strategy.js";
import {
  isFreshQuarter,
  rankLowPerHighRoe,
  safePositiveMarketCap,
  type LowPerHighRoeCandidate,
} from "./shared/fundamental-rank.js";
import { beginRankCycle, finishRankCycle, newRankRiskState, rankLiquidityReady, rankPriceWarmup, rankRiskParameters, type RankRiskState } from "./shared/rank-risk.js";

export const lowPerHighRoeRankParameters = rankRiskParameters.extend({
  topN: z.number().int().min(1).max(200).default(40).meta({
    title: "보유 종목 수",
    description:
      "PER과 ROE 순위 합이 작은 상위 몇 종목을 동일가중으로 보유할지 정합니다.",
  }),
  staleQuarters: z.number().int().min(1).max(8).default(2).meta({
    title: "허용 공시 지연 (분기)",
    description: "순이익과 자본총계 공시가 뒤처져도 허용할 최대 분기 수입니다.",
  }),
});

export type LowPerHighRoeRankParameters = z.infer<
  typeof lowPerHighRoeRankParameters
>;

export type LowPerHighRoeRankState = RankRiskState;

export const lowPerHighRoeRankStrategy: TradingStrategy<
  LowPerHighRoeRankParameters,
  LowPerHighRoeRankState
> = {
  id: "low-per-high-roe-rank",
  version: "2.0.0",
  name: "저PER·고ROE 순위",
  requiresFundamentals: true,
  description:
    "공시 시점의 TTM 순이익과 자본을 사용해 저PER·고ROE 종목을 분산 보유합니다. 코스피 추세에 따라 현금을 늘리고 순위 여유·비중 허용 오차로 잦은 교체를 줄입니다.",
  parameterSchema: lowPerHighRoeRankParameters,
  historyLookbackBars: rankPriceWarmup,
  requiredRebalanceGapBars: 1,
  dataRequirements: {
    marketIndexBars: (parameters) => parameters.marketTrendBars,
    priceWarmupBars: rankPriceWarmup,
    fundamentalFields: ["NET_INCOME", "TOTAL_EQUITY"],
    fundamentalLookbackQuarters: 4,
    fundamentalsReady: (snapshot, tsMs, parameters) =>
      snapshot.ttm("NET_INCOME") !== null &&
      snapshot.get("TOTAL_EQUITY") !== null &&
      isFreshQuarter(
        snapshot.periodKeyOf("NET_INCOME"),
        tsMs,
        parameters.staleQuarters,
      ) &&
      isFreshQuarter(
        snapshot.periodKeyOf("TOTAL_EQUITY"),
        tsMs,
        parameters.staleQuarters,
      ),
    requiresCorporateActions: true,
  },

  initialize(context: StrategyInitializeContext): LowPerHighRoeRankState {
    return newRankRiskState(context.symbols);
  },

  onBars(
    context: StrategyBarContext,
    state: LowPerHighRoeRankState,
    parameters: LowPerHighRoeRankParameters,
  ): StrategyDecision {
    const phase = beginRankCycle(context, state, parameters);
    if (phase !== null) return phase;

    // 일정 없는 독립 엔진 호출은 selectionMetric pin 이 전혀 없다(전부 null). 그대로
    // 진행하면 후보 0 → 목표 0 → 전량 청산이 매 리밸런스 반복되므로 보유를 유지한다.
    // 생산 schedule은 activeUniverseSymbols가 있으므로 아래 완전성 검사로 보낸다.
    if (
      context.activeUniverseSymbols === null &&
      state.symbols.every((symbol) => context.selectionMetric(symbol) === null)
    ) {
      return { orders: [] };
    }

    const candidates: LowPerHighRoeCandidate[] = [];
    for (const symbol of state.symbols) {
      if (
        context.tradableSymbols !== null &&
        !context.tradableSymbols.has(symbol)
      )
        continue;
      const metric = context.selectionMetric(symbol);
      const marketCapKrw = metric?.marketCapKrw ?? undefined;
      if (
        context.activeUniverseSymbols !== null &&
        (marketCapKrw === undefined ||
          safePositiveMarketCap(marketCapKrw) === null)
      ) {
        throw new Error(
          `저PER·고ROE 랭킹에 필요한 유효한 KRX 시가총액이 없습니다: ${symbol}. ` +
            "해당 리밸런스 날짜의 선정 지표를 다시 준비하세요.",
        );
      }
      if (marketCapKrw === undefined) continue;
      const snapshot = context.fundamentals(symbol);
      if (!snapshot) continue;
      if (
        !isFreshQuarter(
          snapshot.periodKeyOf("NET_INCOME"),
          context.tsMs,
          parameters.staleQuarters,
        ) ||
        !isFreshQuarter(
          snapshot.periodKeyOf("TOTAL_EQUITY"),
          context.tsMs,
          parameters.staleQuarters,
        )
      ) {
        continue;
      }
      const netIncomeTtm = snapshot.ttm("NET_INCOME");
      const totalEquity = snapshot.get("TOTAL_EQUITY");
      if (netIncomeTtm === null || totalEquity === null) continue;
      candidates.push({ symbol, marketCapKrw, netIncomeTtm, totalEquity });
    }

    // 선정지표는 있어도 필수 재무 팩트가 전부 누락·stale이면 새 목표를
    // 정할 근거가 없다. 빈 목표로 기존 보유를 전량 매도하지 않고 이번 리밸런스를 건너뛴다.
    if (candidates.length === 0) return { orders: [] };

    const targets = rankLowPerHighRoe(candidates.filter((candidate) =>
      rankLiquidityReady(context, candidate.symbol, parameters)), context.rng)
      .map((candidate) => candidate.symbol);
    return finishRankCycle(targets, context, state, parameters);
  },
};
