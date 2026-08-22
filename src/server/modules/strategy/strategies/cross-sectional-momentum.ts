import { z } from 'zod';
import type { CorporateAction } from '../../facts/domain/fact.js';
import type { Candle } from '../../market-data/domain/candle.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  StrategyInitializeContext,
  TradingStrategy,
} from '../domain/strategy.js';
import { splitAdjustedClose } from './shared/adjusted-price.js';
import { rankDescending, type Scored } from './shared/rank.js';
import { planBuyPhase, planSellPhase } from './shared/two-phase-rebalance.js';

/**
 * 횡단면 모멘텀 (설계 2026-07-29-quant-strategies-and-fact-store-design.md §1).
 *
 * 매 리밸런스 시점에 유니버스 전 종목의 과거 수익률을 랭킹해 상위 N 을 동일가중
 * 보유하고 나머지는 청산한다.
 *
 * 수익률 구간은 `skipDays` 를 뺀 **그 앞** `formationDays` 다 — 구간이 짧아지는 것이
 * 아니라 뒤로 밀린다. 기본값(252 + 21봉)이면 약 13개월 전부터 1개월 전까지의 12개월
 * 수익률이고, 학계에서 12-1 모멘텀이라 부르는 형태다. 소비 timeframe 은 1d 를 전제로
 * 파라미터 기본값이 정해져 있다 (252 거래일 ≈ 12개월, 21 거래일 ≈ 1개월).
 *
 * 리밸런스는 두 봉에 나눈다 — 매도 봉, 그 다음 매수 봉. 엔진의 동시 포지션 상한이
 * 청산 대기 포지션도 슬롯으로 세기 때문이다 (two-phase-rebalance.ts 주석).
 */
export const crossSectionalMomentumParameters = z.object({
  formationDays: z.number().int().min(20).max(756).default(252).meta({
    title: '수익률 측정 기간 (봉 수)',
    description:
      '얼마나 오랜 상승률을 볼지 정합니다. 일봉 기준 252봉이 약 12개월입니다. 길게 잡으면 장기 추세만 잡고, 짧게 잡으면 최근 흐름에 민감해집니다.',
  }),
  skipDays: z.number().int().min(0).max(63).default(21).meta({
    title: '최근 제외 기간 (봉 수)',
    description:
      '가장 최근 N봉을 빼고 그 앞에서 측정 기간만큼 잽니다 — 측정 구간이 짧아지는 것이 아니라 뒤로 밀립니다. 일봉 기준 21봉이 약 1개월이라, 기본값이면 13개월 전부터 1개월 전까지의 12개월 상승률을 봅니다. 갓 오른 종목은 곧 되돌리는 일이 잦아 직전 한 달을 빼는 것이 표준입니다. 0 으로 두면 마지막 봉까지 씁니다.',
  }),
  // 상한은 요청의 `risk.maxPositions` 상한(200)과 같아야 한다 — 제출 게이트가
  // topN <= maxPositions 를 요구하므로 여기가 더 크면 그 구간이 어떤 경로로도
  // 제출될 수 없고, 게이트 메시지는 도달할 수 없는 값까지 올리라고 안내한다.
  topN: z.number().int().min(1).max(200).default(10).meta({
    title: '보유 종목 수',
    description:
      '순위 상위 몇 종목을 동일가중으로 보유할지 정합니다. 종목당 비중은 자본의 1/N 입니다. 요청의 최대 동시 보유 종목 수보다 크게 잡으면 일부 종목이 편입되지 않습니다.',
  }),
  absoluteMomentumFilter: z.boolean().default(true).meta({
    title: '절대 모멘텀 필터',
    description:
      '켜면 측정 기간 수익률이 0 이하인 종목은 순위 상위여도 편입하지 않습니다. 하락장에서 그만큼 현금으로 남습니다. 끄면 하락장에서도 상대적으로 덜 빠진 종목을 보유합니다.',
  }),
});

export type CrossSectionalMomentumParameters = z.infer<typeof crossSectionalMomentumParameters>;

export interface CrossSectionalMomentumState {
  /** 유니버스 — 이번 봉에 거래가 없는 종목도 후보에서 빠지지 않게 초기화 시점에 고정한다 */
  readonly symbols: readonly string[];
  /** 다음 봉에서 동일가중까지 채울 목표 종목. null 이면 매수 단계가 아니다 */
  pendingTargets: readonly string[] | null;
}

/**
 * 분할 보정 종가 기준 모멘텀. 이력이 창을 채우지 못하면 null.
 *
 * 창 종점은 `history.length - 1 - skipDays`, 시작점은 그보다 `formationDays` 앞이다.
 * `history` 는 현재 봉을 포함하므로 종점이 마지막 봉이 되는 것은 `skipDays === 0` 일 때뿐이다.
 */
export function momentumScore(
  history: readonly Candle[],
  actions: readonly CorporateAction[],
  formationDays: number,
  skipDays: number,
): number | null {
  const endIndex = history.length - 1 - skipDays;
  const startIndex = endIndex - formationDays;
  if (startIndex < 0) return null;

  const start = splitAdjustedClose(history, actions, startIndex);
  const end = splitAdjustedClose(history, actions, endIndex);
  if (start === null || end === null || start <= 0) return null;
  return end / start - 1;
}

export const crossSectionalMomentumStrategy: TradingStrategy<
  CrossSectionalMomentumParameters,
  CrossSectionalMomentumState
> = {
  id: 'cross-sectional-momentum',
  version: '2.2.0',
  name: '횡단면 모멘텀',
  description:
    // "보정합니다" 로 단정하면 안 된다 — 분할 이력이 수집되지 않은 데이터셋에서는
    // 자본변동 팩트가 없어 원 종가로 계산된다. 무엇도 그 수집을 강제하지 않으므로
    // (requiresFundamentals 는 이 전략에 걸려 있지도 않다) 엔진 경고·
    // IMPLEMENTATION_STATUS 와 같은 어법으로 조건을 밝힌다.
    '유니버스 전 종목의 상승률을 견줘 많이 오른 상위 N 을 동일가중 보유하고, 주기마다 순위를 다시 매겨 갈아탑니다. ' +
    '상승률은 직전 한 달을 빼고 그 앞 1년을 봅니다 — 갓 오른 종목은 곧 되돌리는 일이 잦기 때문입니다. ' +
    '액면분할은 분할 이력이 수집된 데이터셋에서만 신호 계산에 보정됩니다 — 체결가는 항상 실제 거래 가격입니다.',
  parameterSchema: crossSectionalMomentumParameters,
  dataRequirements: {
    priceWarmupBars: (parameters) => parameters.formationDays + parameters.skipDays + 1,
    requiresCorporateActions: true,
  },

  initialize(context: StrategyInitializeContext): CrossSectionalMomentumState {
    return {
      symbols: [...context.symbols],
      pendingTargets: null,
    };
  },

  onBars(
    context: StrategyBarContext,
    state: CrossSectionalMomentumState,
    parameters: CrossSectionalMomentumParameters,
  ): StrategyDecision {
    // 2단계 — 이전 봉에서 넘어온 목표 종목을 동일가중까지 채운다. 이번 봉에
    // 초과 비중·탈락 종목 매도가 이미 체결되어 현금이 들어온 상태다
    // (엔진 §9.2 순서: 체결 → 평가 → 전략).
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

    // 준비 파이프라인은 거래 시작 전 워밍업 이력을 채운다. 직접 엔진을 호출해 이력이
    // 부족한 경우에는 이 공유 리밸런스 봉에서 아무 주문도 내지 않는다. 이 경우와 후보가
    // '필터에 걸려' 빈 경우는 다르다 — 후자는 목표가 빈 채로 진행해 전량 청산한다.
    const minBars = parameters.formationDays + parameters.skipDays + 1;
    const warmedUp = state.symbols.some(
      (symbol) => context.getHistory(symbol).length >= minBars,
    );
    if (!warmedUp) return { orders: [] };

    const scored: Scored[] = [];
    for (const symbol of state.symbols) {
      // 유니버스에서 밀려난 종목은 랭킹 후보에서도 뺀다 — 여기서 안 빼면 그 슬롯이
      // topN 을 차지한 채 매수 단계에서만 걸러지고, budgetPerSymbol 은 topN 고정이라
      // 그만큼 예산이 그냥 현금으로 논다(차순위 후보가 슬롯을 못 받는다).
      if (context.tradableSymbols !== null && !context.tradableSymbols.has(symbol)) continue;
      const score = momentumScore(
        context.getHistory(symbol),
        context.corporateActions(symbol),
        parameters.formationDays,
        parameters.skipDays,
      );
      if (score === null) continue;
      if (parameters.absoluteMomentumFilter && score <= 0) continue;
      scored.push({ symbol, score });
    }

    const ranks = rankDescending(scored, context.rng);
    const targets = [...ranks.entries()]
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
