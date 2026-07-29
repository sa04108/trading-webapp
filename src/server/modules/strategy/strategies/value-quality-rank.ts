import { z } from 'zod';
import type { FundamentalField, FundamentalSnapshot } from '../../facts/domain/fact.js';
import { quarterOrdinal } from '../../facts/domain/pit-fact-view.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  StrategyInitializeContext,
  TradingStrategy,
} from '../domain/strategy.js';
import { rankDescending, type Scored } from './shared/rank.js';
import { isRebalanceDue, localMonthKey } from './shared/rebalance-schedule.js';
import { planBuyPhase, planSellPhase } from './shared/two-phase-rebalance.js';

/**
 * 밸류·퀄리티 랭킹 (설계 2026-07-29-quant-strategies-and-fact-store-design.md §2).
 *
 * 이익수익률(TTM EBIT / EV) 과 자본수익률(TTM EBIT / 투입자본) 을 각각 순위 매겨
 * 합산하고, 합이 작은 상위 N 을 동일가중 보유한다.
 *
 * 비율을 팩트로 저장하지 않는 이유: 시가총액은 매 봉 종가에 따라 변한다. 원자료만
 * 저장하고 여기서 봉 시점 가격으로 계산한다.
 *
 * 연결(CFS)/별도(OFS) 는 파라미터가 아니라 **수집 시점 선택**이다 — Fact 스키마에
 * 두 기준을 함께 담을 자리가 없다. 데이터셋 하나는 한 기준만 담는다.
 */
export const valueQualityRankParameters = z.object({
  topN: z.number().int().min(1).max(50).default(20).meta({
    title: '보유 종목 수',
    description:
      '두 지표 순위 합이 작은 상위 몇 종목을 동일가중으로 보유할지 정합니다. 종목당 비중은 자본의 1/N 입니다.',
  }),
  rebalanceMonths: z.number().int().min(1).max(12).default(3).meta({
    title: '리밸런스 주기 (개월)',
    description:
      '몇 개월마다 순위를 다시 매길지 정합니다. 분기 재무가 갱신되는 주기와 맞춰 3개월이 기본입니다. 새 주기의 첫 거래일에 실행됩니다.',
  }),
  staleQuarters: z.number().int().min(1).max(8).default(2).meta({
    title: '허용 공시 지연 (분기)',
    description:
      '가장 최근 공시가 현재 분기로부터 몇 분기까지 낡아도 후보로 볼지 정합니다. 작게 잡으면 공시가 끊긴 관리종목·상장폐지 직전 종목이 순위 상위에 오르는 것을 막습니다.',
  }),
});

export type ValueQualityRankParameters = z.infer<typeof valueQualityRankParameters>;

export interface ValueQualityRankState {
  readonly symbols: readonly string[];
  lastRebalanceMonthKey: string | null;
  pendingBuys: readonly string[] | null;
}

export interface ValueQualityMetrics {
  /** TTM EBIT / EV */
  readonly earningsYield: number;
  /** TTM EBIT / (순운전자본 + 유형자산) */
  readonly returnOnCapital: number;
}

const DEBT_FIELDS: readonly FundamentalField[] = [
  'SHORT_TERM_BORROWINGS',
  'CURRENT_LONG_TERM_DEBT',
  'BONDS',
  'LONG_TERM_BORROWINGS',
];

const CASH_FIELDS: readonly FundamentalField[] = ['CASH_AND_EQUIVALENTS', 'SHORT_TERM_INVESTMENTS'];

function sumFields(
  snapshot: FundamentalSnapshot,
  fields: readonly FundamentalField[],
): number {
  let total = 0;
  for (const field of fields) total += snapshot.get(field) ?? 0;
  return total;
}

/** 봉 시각의 KST 월을 분기 서수로 접는다 (quarterOrdinal 과 같은 눈금) */
export function currentQuarterOrdinal(tsMs: number): number {
  const [year, month] = localMonthKey(tsMs).split('-').map(Number) as [number, number];
  return year * 4 + Math.floor((month - 1) / 3);
}

/**
 * 두 지표 계산. 후보 자격이 없으면 null 을 준다 — 호출부가 조용히 0 으로 세지 않도록
 * 제외 사유를 전부 여기서 흡수한다.
 */
export function computeValueQualityMetrics(
  snapshot: FundamentalSnapshot,
  close: number,
  currentQuarter: number,
  staleQuarters: number,
): ValueQualityMetrics | null {
  if (!Number.isFinite(close) || close <= 0) return null;

  // 공시가 너무 낡았으면 제외 (관리종목·상장폐지 직전)
  const latestQuarter =
    snapshot.latestPeriodKey === null ? null : quarterOrdinal(snapshot.latestPeriodKey);
  if (latestQuarter === null) return null;
  if (currentQuarter - latestQuarter > staleQuarters) return null;

  const ebit = snapshot.ttm('OPERATING_INCOME');
  if (ebit === null || ebit <= 0) return null; // 원 규칙: 적자 기업 제외

  const shares = snapshot.get('SHARES_OUTSTANDING');
  if (shares === null || shares <= 0) return null;

  const marketCap = close * shares;
  const enterpriseValue = marketCap + sumFields(snapshot, DEBT_FIELDS) - sumFields(snapshot, CASH_FIELDS);
  if (enterpriseValue <= 0) return null; // 현금이 시총+차입금을 넘는 경우 — 비율이 무의미해진다

  const currentAssets = snapshot.get('CURRENT_ASSETS');
  const currentLiabilities = snapshot.get('CURRENT_LIABILITIES');
  const tangibleAssets = snapshot.get('TANGIBLE_ASSETS');
  if (currentAssets === null || currentLiabilities === null || tangibleAssets === null) return null;

  // 순운전자본이 음수면 0 으로 깎는다 (Greenblatt 관례) — 음수 투입자본은 부호를 뒤집는다
  const workingCapital = Math.max(currentAssets - currentLiabilities, 0);
  const investedCapital = workingCapital + tangibleAssets;
  if (investedCapital <= 0) return null;

  return {
    earningsYield: ebit / enterpriseValue,
    returnOnCapital: ebit / investedCapital,
  };
}

export const valueQualityRankStrategy: TradingStrategy<
  ValueQualityRankParameters,
  ValueQualityRankState
> = {
  id: 'value-quality-rank',
  version: '1.0.0',
  name: '밸류·퀄리티 랭킹',
  description:
    '이익수익률(EBIT/EV)과 자본수익률(EBIT/투입자본) 순위를 합산해 상위 N 을 동일가중 보유합니다. 상장시점 재무제표가 수집된 데이터셋에서만 동작합니다.',
  parameterSchema: valueQualityRankParameters,

  initialize(context: StrategyInitializeContext): ValueQualityRankState {
    return { symbols: [...context.symbols], lastRebalanceMonthKey: null, pendingBuys: null };
  },

  onBars(
    context: StrategyBarContext,
    state: ValueQualityRankState,
    parameters: ValueQualityRankParameters,
  ): StrategyDecision {
    if (state.pendingBuys !== null) {
      const buys = planBuyPhase(state.pendingBuys, {
        positions: context.portfolio.positions,
        bars: context.bars,
        equity: context.portfolio.equity,
        topN: parameters.topN,
      });
      state.pendingBuys = null;
      return { orders: buys };
    }

    const monthKey = localMonthKey(context.tsMs);
    if (!isRebalanceDue(state.lastRebalanceMonthKey, monthKey, parameters.rebalanceMonths)) {
      return { orders: [] };
    }

    const currentQuarter = currentQuarterOrdinal(context.tsMs);
    const earningsYield: Scored[] = [];
    const returnOnCapital: Scored[] = [];

    for (const symbol of state.symbols) {
      const snapshot = context.fundamentals(symbol);
      const close = context.bars.get(symbol)?.close;
      if (!snapshot || close === undefined) continue;
      const metrics = computeValueQualityMetrics(
        snapshot,
        close,
        currentQuarter,
        parameters.staleQuarters,
      );
      if (!metrics) continue;
      earningsYield.push({ symbol, score: metrics.earningsYield });
      returnOnCapital.push({ symbol, score: metrics.returnOnCapital });
    }

    // 재무가 아직 하나도 공시되지 않았으면 리밸런스 시점을 소진하지 않는다 —
    // 다음 봉에서 다시 본다. 후보가 '자격 미달로' 비는 것과 구분되지 않지만, 둘 다
    // 아무것도 사지 않는 것이 정답이므로 같은 경로로 둔다.
    if (earningsYield.length === 0) return { orders: [] };

    const yieldRanks = rankDescending(earningsYield);
    const capitalRanks = rankDescending(returnOnCapital);
    const combined: Scored[] = earningsYield.map(({ symbol }) => ({
      symbol,
      // 순위 합이 작을수록 좋다 — rankDescending 은 큰 값을 1위로 두므로 부호를 뒤집는다
      score: -((yieldRanks.get(symbol) ?? 0) + (capitalRanks.get(symbol) ?? 0)),
    }));

    const finalRanks = rankDescending(combined);
    const targets = [...finalRanks.entries()]
      .filter(([, rank]) => rank <= parameters.topN)
      .map(([symbol]) => symbol)
      .sort();

    state.lastRebalanceMonthKey = monthKey;

    const sells = planSellPhase({ targets, positions: context.portfolio.positions });
    const newEntries = targets.filter(
      (symbol) => (context.portfolio.positions.get(symbol)?.quantity ?? 0) <= 0,
    );
    state.pendingBuys = newEntries.length > 0 ? newEntries : null;

    return { orders: sells };
  },
};
