import { z } from "zod";
import type { StrategyBarContext, StrategyDecision } from "../../domain/strategy.js";
import { planBuyPhase, planSellPhase } from "./two-phase-rebalance.js";

export const rankRiskParameters = z.object({
  marketTrendBars: z.number().int().min(0).max(400).refine((n) => n === 0 || n >= 20).default(200).meta({
    title: "KOSPI 추세 기간 (거래일)",
    description: "코스피 종가가 단순이동평균을 하회하면 위험 노출을 줄입니다. 이동평균보다 1% 넘게 회복한 뒤 다음 순위 교체에서 정상 비중으로 복귀합니다. 0이면 시장 필터를 끕니다. 실제 지수 이력이 필요합니다.",
  }),
  riskOffExposurePercent: z.number().min(0).max(100).default(30).meta({
    title: "하락장 투자 비율 (%)",
    description: "코스피가 이동평균 아래일 때 정상 투자금의 이 비율만 보유하고 나머지는 현금으로 둡니다. 0이면 전량 현금화합니다.",
  }),
  investmentPercent: z.number().min(1).max(100).default(95).meta({
    title: "정상장 투자 비율 (%)",
    description: "전체 자산 중 주식에 배분할 비율입니다. 기본 95%로 수수료와 가격 변동에 필요한 현금을 남깁니다.",
  }),
  minRebalanceBars: z.number().int().min(1).max(252).default(20).meta({
    title: "최소 교체 간격 (거래일)",
    description: "유니버스 리밸런스 신호 중 직전 순위 교체에서 이 기간 이상 지난 신호만 사용합니다. 하락장 비중 축소는 매 거래일 확인합니다.",
  }),
  rankBufferPercent: z.number().min(0).max(100).default(25).meta({
    title: "보유 종목 순위 여유 (%)",
    description: "기존 보유 종목은 목표 종목 수보다 이 비율만큼 낮은 순위까지 유지합니다. 경계 순위의 잦은 교체를 줄이며 자격 미달 종목은 제외합니다.",
  }),
  rebalanceBandPercent: z.number().min(0).max(100).default(20).meta({
    title: "비중 조정 허용 오차 (%)",
    description: "기존 종목의 보유 금액과 목표 금액 차이가 목표의 이 비율 이내면 수량을 조정하지 않습니다. 신규 편입·탈락·하락장 축소에는 적용하지 않습니다.",
  }),
  liquidityLookbackBars: z.number().int().min(2).max(126).default(20).meta({
    title: "거래대금 기간 (거래일)",
    description: "종가 × 거래량으로 추정한 거래대금의 최근 평균을 사용합니다. 실제 체결 거래대금과 차이가 있을 수 있습니다.",
  }),
  minAverageTradingValueKrw: z.number().min(0).max(1_000_000_000_000).default(100_000_000).meta({
    title: "최소 평균 거래대금 (원)",
    description: "평균 추정 거래대금이 이 값보다 작은 종목을 제외합니다. 기본 1억원이며 0이면 거래대금 필터를 끕니다.",
  }),
});
export type RankRiskParameters = z.infer<typeof rankRiskParameters>;
export interface RankRiskState {
  readonly symbols: readonly string[];
  pendingTargets: readonly string[] | null;
  barsSeen: number;
  lastTsMs: number | null;
  lastRebalanceBar: number | null;
  allocation: number | null;
  riskOn: boolean | null;
  reducing: boolean;
}

export function newRankRiskState(symbols: readonly string[]): RankRiskState {
  return { symbols: [...symbols], pendingTargets: null, barsSeen: 0, lastTsMs: null,
    lastRebalanceBar: null, allocation: null, riskOn: null, reducing: false };
}

export function rankPriceWarmup(parameters: RankRiskParameters): number {
  return parameters.minAverageTradingValueKrw > 0 ? parameters.liquidityLookbackBars : 1;
}

export function rankLiquidityReady(context: StrategyBarContext, symbol: string, parameters: RankRiskParameters): boolean {
  if (parameters.minAverageTradingValueKrw === 0) return true;
  const history = context.getHistory(symbol);
  if (history.length < parameters.liquidityLookbackBars) return false;
  let total = 0;
  for (let i = history.length - parameters.liquidityLookbackBars; i < history.length; i++) {
    const bar = history[i]!;
    const value = bar.close * bar.volume;
    if (!Number.isFinite(value) || value < 0) return false;
    total += value;
  }
  return total / parameters.liquidityLookbackBars >= parameters.minAverageTradingValueKrw;
}

function allocation(context: StrategyBarContext, state: RankRiskState, parameters: RankRiskParameters): number | null {
  const normal = parameters.investmentPercent / 100;
  if (parameters.marketTrendBars === 0) return normal;
  const history = context.getMarketIndexHistory?.() ?? [];
  const latest = history.at(-1);
  if (history.length < parameters.marketTrendBars || latest?.tsMs !== context.tsMs) {
    // 준비 봉에는 아직 지표 창이 짧을 수 있다. 실제 판단·보유 단계에서는 결측을 정상장으로 대체하지 않는다.
    if (context.isRebalanceBar || context.portfolio.positions.size > 0)
      throw new Error(`KOSPI 시장 필터에 필요한 확정 지수 ${parameters.marketTrendBars}거래일 이력이 부족하거나 현재 거래일 값이 없습니다.`);
    return null;
  }
  const prices = history.slice(-parameters.marketTrendBars);
  if (prices.some((point) => !Number.isFinite(point.close) || point.close <= 0 || point.tsMs > context.tsMs))
    throw new Error("KOSPI 시장 필터 지수 이력이 올바르지 않습니다.");
  const average = prices.reduce((sum, point) => sum + point.close, 0) / prices.length;
  // 이동평균 부근의 반복 매매를 줄이기 위해 복귀에는 1% 여유를 둔다.
  state.riskOn = state.riskOn === null ? latest.close >= average
    : state.riskOn ? latest.close >= average : latest.close > average * 1.01;
  return normal * (state.riskOn ? 1 : parameters.riskOffExposurePercent / 100);
}

/** null이면 이번 봉에서 순위를 계산한다. 방어적 축소와 매수 단계는 그 전에 처리한다. */
export function beginRankCycle(context: StrategyBarContext, state: RankRiskState,
  parameters: RankRiskParameters & { topN: number }): StrategyDecision | null {
  if (state.lastTsMs !== context.tsMs) { state.barsSeen++; state.lastTsMs = context.tsMs; }
  const next = allocation(context, state, parameters);
  if (next === null) return { orders: [] };
  // 비활성 상태에서 지표를 준비한 뒤 기존 포지션으로 시작해도 첫 순위 계산 전에 방어 한도를 적용한다.
  const initialRiskOff = state.lastRebalanceBar === null && next < parameters.investmentPercent / 100 &&
    [...context.portfolio.positions.values()].some((position) => position.quantity > 0);
  const reduced = initialRiskOff || (state.allocation !== null && next < state.allocation);
  if (state.allocation !== null && next > state.allocation) state.reducing = false;
  state.allocation = next;
  if (reduced) {
    state.pendingTargets = null;
    state.reducing = true;
  }
  if (state.reducing) {
    // 비활성 중 topN을 줄여도 기존 포지션은 남는다. 보유 수가 더 많으면 전체 투자 한도를 나눠 적용한다.
    const heldCount = [...context.portfolio.positions.values()].filter((position) => position.quantity > 0).length;
    const orders = planSellPhase({ targets: [...context.portfolio.positions.keys()],
      positions: context.portfolio.positions, bars: context.bars,
      equity: context.portfolio.equity * next, topN: Math.max(parameters.topN, heldCount) });
    if (orders.length > 0) return { orders: orders.map((order) => ({ ...order, reason: "MARKET_RISK_OFF" })) };
    state.reducing = [...context.portfolio.positions.values()].some((position) =>
      position.quantity > 0 && !context.bars.has(position.symbol));
    if (state.reducing) return { orders: [] };
  }
  if (state.pendingTargets !== null) {
    const orders = planBuyPhase(state.pendingTargets, { positions: context.portfolio.positions,
      bars: context.bars, equity: context.portfolio.equity * next, topN: parameters.topN,
      tradableSymbols: context.tradableSymbols, rebalanceBandPercent: parameters.rebalanceBandPercent });
    state.pendingTargets = null;
    return { orders };
  }
  if (!context.isRebalanceBar || (state.lastRebalanceBar !== null &&
      state.barsSeen - state.lastRebalanceBar < parameters.minRebalanceBars)) return { orders: [] };
  return null;
}

export function finishRankCycle(rankedSymbols: readonly string[], context: StrategyBarContext,
  state: RankRiskState, parameters: RankRiskParameters & { topN: number }): StrategyDecision {
  const retained = rankedSymbols.slice(0, Math.ceil(parameters.topN * (1 + parameters.rankBufferPercent / 100)))
    .filter((symbol) => (context.portfolio.positions.get(symbol)?.quantity ?? 0) > 0).slice(0, parameters.topN);
  const selected = new Set(retained);
  for (const symbol of rankedSymbols) {
    if (selected.size >= parameters.topN) break;
    selected.add(symbol);
  }
  const targets = [...selected].sort();
  const orders = planSellPhase({ targets, positions: context.portfolio.positions, bars: context.bars,
    equity: context.portfolio.equity * (state.allocation ?? 0), topN: parameters.topN,
    rebalanceBandPercent: parameters.rebalanceBandPercent });
  state.pendingTargets = targets.length > 0 && (state.allocation ?? 0) > 0 ? targets : null;
  state.lastRebalanceBar = state.barsSeen;
  return { orders };
}
