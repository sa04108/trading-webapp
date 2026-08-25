import { z } from 'zod';
import type { FundamentalField, FundamentalSnapshot } from '../../facts/domain/fact.js';
import { quarterOrdinal } from '../../facts/domain/pit-fact-view.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  StrategyInitializeContext,
  TradingStrategy,
} from '../domain/strategy.js';
import {
  currentQuarterOrdinal,
  safePositiveMarketCap,
} from './shared/fundamental-rank.js';
import { rankDescending, type Scored } from './shared/rank.js';
import { planBuyPhase, planSellPhase } from './shared/two-phase-rebalance.js';

/**
 * 밸류·퀄리티 랭킹 (설계 2026-07-29-quant-strategies-and-fact-store-design.md §2).
 *
 * 이익수익률(TTM EBIT / EV) 과 자본수익률(TTM EBIT / 투입자본) 을 각각 순위 매겨
 * 합산하고, 합이 작은 상위 N 을 동일가중 보유한다.
 *
 * 비율을 팩트로 저장하지 않는 이유: 계산 입력은 리밸런스 시점에 따라 변한다.
 * 원자료(KRX 시점 시가총액과 PIT 재무)만 저장하고 여기서 계산한다.
 *
 * 연결(CFS)/별도(OFS) 는 파라미터가 아니라 **수집 시점 선택**이다 — Fact 스키마에
 * 두 기준을 함께 담을 자리가 없다. 데이터셋 하나는 한 기준만 담는다.
 */
export const valueQualityRankParameters = z.object({
  // 상한은 요청의 `risk.maxPositions` 상한(200)과 같아야 한다 — 제출 게이트가
  // topN <= maxPositions 를 요구하므로 여기가 더 크면 그 구간이 어떤 경로로도
  // 제출될 수 없고, 게이트 메시지는 도달할 수 없는 값까지 올리라고 안내한다.
  topN: z.number().int().min(1).max(200).default(20).meta({
    title: '보유 종목 수',
    description:
      '두 지표 순위 합이 작은 상위 몇 종목을 동일가중으로 보유할지 정합니다. 종목당 비중은 자본의 1/N 입니다.',
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
  pendingTargets: readonly string[] | null;
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

/**
 * 생산 경로의 computeValueQualityMetrics 가 실제로 읽는 계정 전체 — 계정별 신선도
 * 판정에 쓴다. 일정 없는 호환 경로는 SHARES_OUTSTANDING을 동적으로 더한다.
 * 부채·현금 계정은 공시가 없으면(periodKeyOf 가 null) 자연히 판정에서 빠진다 —
 * "공시 안 됨" 을 "무한히 낡음" 으로 세지 않기 위해서다 (sumFields 가 같은 계정을
 * 0 으로 취급하는 것과 대응된다).
 */
const CONSULTED_FIELDS: readonly FundamentalField[] = [
  'OPERATING_INCOME',
  'CURRENT_ASSETS',
  'CURRENT_LIABILITIES',
  'TANGIBLE_ASSETS',
  ...DEBT_FIELDS,
  ...CASH_FIELDS,
];

function sumFields(
  snapshot: FundamentalSnapshot,
  fields: readonly FundamentalField[],
): number {
  let total = 0;
  for (const field of fields) total += snapshot.get(field) ?? 0;
  return total;
}

// 달력 경계 계산은 한 곳에만 둔다 — 복제본이 있으면 KST off-by-one 을 한쪽만 고친다.
export { currentQuarterOrdinal };

/**
 * 두 지표 계산. 후보 자격이 없으면 null 을 준다 — 호출부가 조용히 0 으로 세지 않도록
 * 제외 사유를 전부 여기서 흡수한다.
 */
export function computeValueQualityMetrics(
  snapshot: FundamentalSnapshot,
  close: number,
  currentQuarter: number,
  staleQuarters: number,
  /** 리밸런스 시점 KRX 시가총액. 일정 없는 직접 호출만 종가×공시주식수로 대체한다. */
  marketCapKrw?: string,
): ValueQualityMetrics | null {
  // 1차 관문 — 분기 키 형식 자체가 아니거나 공시가 아예 없으면 계정별 판정으로도
  // 넘어가지 않는다 (신고 자체가 끊긴 관리종목·상장폐지 직전 종목).
  if (snapshot.latestPeriodKey === null || quarterOrdinal(snapshot.latestPeriodKey) === null) {
    return null;
  }

  const ebit = snapshot.ttm('OPERATING_INCOME');
  if (ebit === null || ebit <= 0) return null; // 원 규칙: 적자 기업 제외

  let marketCap: number;
  if (marketCapKrw !== undefined) {
    const parsed = safePositiveMarketCap(marketCapKrw);
    if (parsed === null) return null;
    marketCap = parsed;
  } else {
    // 일정이 없는 순수 엔진 호출의 호환 경로다. 생산 실행은 KRX 시가총액을 넘겨
    // 분할 뒤 종가와 아직 갱신되지 않은 분기 공시 주식수의 단위 불일치를 피한다.
    if (!Number.isFinite(close) || close <= 0) return null;
    const shares = snapshot.get('SHARES_OUTSTANDING');
    if (shares === null || shares <= 0) return null;
    marketCap = close * shares;
    if (!Number.isFinite(marketCap) || marketCap <= 0) return null;
  }

  const currentAssets = snapshot.get('CURRENT_ASSETS');
  const currentLiabilities = snapshot.get('CURRENT_LIABILITIES');
  const tangibleAssets = snapshot.get('TANGIBLE_ASSETS');
  if (currentAssets === null || currentLiabilities === null || tangibleAssets === null) return null;

  // 계정별 신선도 — 이 지표가 실제로 읽는 계정들 중 "가장 낡은 것" 을 기준으로 판정한다.
  // latestPeriodKey(전사 최댓값)만 보면 손익계산서만 최신이어도 재무상태표 계정이
  // 몇 년째 갱신되지 않은 회사가 통과해버리는 구멍이 있었다 — staleQuarters 라는
  // 이름·설명이 약속하는 것과 실제 동작이 달랐다. periodKeyOf 가 null 인 계정(공시
  // 자체가 없는 선택 계정)은 값을 낸 적이 없으므로 판정에서 자연히 빠진다.
  const accountFields = marketCapKrw === undefined
    ? [...CONSULTED_FIELDS, 'SHARES_OUTSTANDING' as const]
    : CONSULTED_FIELDS;
  const accountQuarters = accountFields.map((field) => snapshot.periodKeyOf(field))
    .map((periodKey) => (periodKey === null ? null : quarterOrdinal(periodKey)))
    .filter((ordinal): ordinal is number => ordinal !== null);
  if (accountQuarters.length === 0) return null; // 위에서 필수 계정을 이미 확인했으니 도달 불가 — 방어적 가드
  const oldestQuarter = Math.min(...accountQuarters);
  if (currentQuarter - oldestQuarter > staleQuarters) return null;

  const enterpriseValue = marketCap + sumFields(snapshot, DEBT_FIELDS) - sumFields(snapshot, CASH_FIELDS);
  if (enterpriseValue <= 0) return null; // 현금이 시총+차입금을 넘는 경우 — 비율이 무의미해진다

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
  version: '2.3.0',
  name: '밸류·퀄리티 랭킹',
  description:
    '이익수익률(EBIT/EV)과 자본수익률(EBIT/투입자본) 순위를 합산해 상위 N 을 동일가중 보유합니다. 상장시점 재무제표가 수집된 데이터셋에서만 동작합니다.',
  requiresFundamentals: true,
  parameterSchema: valueQualityRankParameters,
  requiredRebalanceGapBars: 1,
  dataRequirements: {
    fundamentalLookbackQuarters: 4,
    // 엔진의 포지션 수량 보정도 최종 유니버스 자본변동 이력을 소비한다.
    requiresCorporateActions: true,
  },

  initialize(context: StrategyInitializeContext): ValueQualityRankState {
    return { symbols: [...context.symbols], pendingTargets: null };
  },

  onBars(
    context: StrategyBarContext,
    state: ValueQualityRankState,
    parameters: ValueQualityRankParameters,
  ): StrategyDecision {
    if (state.pendingTargets !== null) {
      const buys = planBuyPhase(state.pendingTargets, {
        positions: context.portfolio.positions,
        bars: context.bars,
        equity: context.portfolio.equity,
        topN: parameters.topN,
        tradableSymbols: context.tradableSymbols,
      });
      state.pendingTargets = null;
      return { orders: buys };
    }

    if (!context.isRebalanceBar) return { orders: [] };

    const currentQuarter = currentQuarterOrdinal(context.tsMs);
    const earningsYield: Scored[] = [];
    const returnOnCapital: Scored[] = [];

    for (const symbol of state.symbols) {
      // 유니버스에서 밀려난 종목은 랭킹 후보에서도 뺀다 — cross-sectional-momentum.ts
      // 와 같은 이유(여기서 안 빼면 그 슬롯이 topN 을 차지한 채 매수 단계에서만
      // 걸러지고, 그만큼 예산이 그냥 현금으로 논다)
      if (context.tradableSymbols !== null && !context.tradableSymbols.has(symbol)) continue;
      const marketCapKrw = context.selectionMetric(symbol)?.marketCapKrw ?? undefined;
      // 생산 실행의 시점별 schedule은 activeUniverseSymbols를 항상 구체화한다.
      // 그 일정에서 시총만 빠졌는지는 재무 스냅샷 유무와 무관하게 검증한다.
      if (
        context.activeUniverseSymbols !== null
        && (marketCapKrw === undefined || safePositiveMarketCap(marketCapKrw) === null)
      ) {
        throw new Error(
          `밸류·퀄리티 랭킹에 필요한 유효한 KRX 시가총액이 없습니다: ${symbol}. `
            + '해당 리밸런스 날짜의 선정 지표를 다시 준비하세요.',
        );
      }
      const snapshot = context.fundamentals(symbol);
      const close = context.bars.get(symbol)?.close;
      if (!snapshot || close === undefined) continue;
      const metrics = computeValueQualityMetrics(
        snapshot,
        close,
        currentQuarter,
        parameters.staleQuarters,
        marketCapKrw,
      );
      if (!metrics) continue;
      earningsYield.push({ symbol, score: metrics.earningsYield });
      returnOnCapital.push({ symbol, score: metrics.returnOnCapital });
    }

    // 재무가 아직 하나도 공시되지 않았으면 이번 공유 리밸런스 봉에서는 기존 보유를
    // 유지한다. 데이터 없음과 전 종목 자격 미달을 구분할 근거가 없으므로 같은 경로다.
    if (earningsYield.length === 0) return { orders: [] };

    const yieldRanks = rankDescending(earningsYield, context.rng);
    const capitalRanks = rankDescending(returnOnCapital, context.rng);
    const combined: Scored[] = earningsYield.map(({ symbol }) => ({
      symbol,
      // 순위 합이 작을수록 좋다 — rankDescending 은 큰 값을 1위로 두므로 부호를 뒤집는다
      score: -((yieldRanks.get(symbol) ?? 0) + (capitalRanks.get(symbol) ?? 0)),
    }));

    const finalRanks = rankDescending(combined, context.rng);
    const targets = [...finalRanks.entries()]
      .filter(([, rank]) => rank <= parameters.topN)
      .map(([symbol]) => symbol)
      .sort();

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
