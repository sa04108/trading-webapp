import { z } from 'zod';
import type { OrderIntent } from '../../backtest/domain/types.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  TradingStrategy,
  StrategyInitializeContext,
} from '../domain/strategy.js';
import {
  newAtr,
  newEma,
  scaleAtr,
  scaleEma,
  updateAtr,
  updateEma,
  type AtrState,
  type EmaState,
} from './shared/indicators.js';
import {
  newCorrelationWarmup,
  pruneWarmupCloses,
  recordClose,
  scaleWarmupCloses,
  tryBuildGroups,
  type CorrelationWarmup,
} from './shared/pair-groups.js';
import { riskQuantity } from './shared/position-sizing.js';
import {
  confirmEntry,
  holdLimitReached,
  newHolding,
  scaleHoldingPrices,
  updateTrail,
  type HoldingState,
} from './shared/trailing-stop.js';

/**
 * EMA 추세 스위치 (설계 2026-07-30-swing-strategies-design.md §3).
 *
 * 단기·장기 EMA 간격이 임계%를 넘은 종목을 사고, 트레일링 스톱·추세 반전·보유
 * 상한으로 판다. 모든 창이 봉 수라 분봉 데이트레이딩부터 일봉 스윙까지 같은
 * 로직이다.
 *
 * 방향은 종목 선택으로 표현된다: 역상관 종목(예: 레버리지·곱버스)을 함께 넣으면
 * 상승 추세에선 한쪽만, 하락 추세에선 반대쪽만 조건을 만족한다. 워밍업 후
 * 계산하고 리밸런스와 활성 멤버십 변화에 맞춰 갱신하는 상관 그룹이 같은 묶음의 동시 보유를
 * 막는다 — 전략은 어느 종목이 인버스인지 모른다.
 */
export const emaTrendSwitchParameters = z
  .object({
    fastEmaBars: z.number().int().min(2).max(100).default(12).meta({
      title: '단기 이동평균 봉 수',
      description:
        '최근 흐름을 재는 짧은 지수이동평균의 봉 수입니다. 장기 이동평균보다 작아야 합니다.',
    }),
    slowEmaBars: z.number().int().min(5).max(400).default(26).meta({
      title: '장기 이동평균 봉 수',
      description: '기준 추세를 재는 긴 지수이동평균의 봉 수입니다.',
    }),
    entryThresholdPercent: z.number().min(0.01).max(10).default(0.3).meta({
      title: '진입 간격 (%)',
      description:
        '단기 이동평균이 장기보다 이 비율(%) 이상 위에 있으면 진입합니다. 크게 잡으면 뚜렷한 추세만 잡습니다.',
    }),
    atrPeriod: z.number().int().min(2).max(100).default(14).meta({
      title: '변동성(ATR) 계산 기간',
      description: '손절 폭과 주문 수량의 기준이 되는 변동성을 몇 개 봉으로 평균낼지 정합니다.',
    }),
    stopAtrMultiplier: z.number().positive().max(20).default(2).meta({
      title: '손절 폭 (변동성 배수)',
      description: '진입가에서 변동성 × 이 값만큼 내려가면 손절합니다. 주문 수량 계산에도 쓰입니다.',
    }),
    trailAtrMultiplier: z.number().positive().max(20).default(2).meta({
      title: '추적 손절 폭 (변동성 배수)',
      description: '보유 중 고점에서 변동성 × 이 값만큼 내려오면 팝니다. 고점을 따라 손절선이 올라갑니다.',
    }),
    // 라벨에 "(선택)" 을 쓰지 않는다 — 위저드가 optional 파라미터에 붙여준다
    maxHoldBars: z.number().int().min(1).max(10_000).optional().meta({
      title: '최대 보유 봉 수',
      description:
        '이 봉 수를 넘기면 신호와 무관하게 팝니다. 일봉 기준으로 20이면 약 1달입니다. 비우면 제한이 없습니다.',
    }),
    riskPerTradePercent: z.number().positive().max(5).default(1).meta({
      title: '1회 거래 리스크 (%)',
      description: '한 번의 거래에서 감당할 자본 비율입니다. 주문 수량 = 자본 × 이 비율 ÷ 손절 폭.',
    }),
    correlationBars: z.number().int().min(20).max(500).default(60).meta({
      title: '상관 계산 봉 수',
      description:
        '활성 종목 중 이 봉 수를 확보한 종목이 생기면 종목쌍별 상관을 계산해 반대로 움직이는 종목들을 한 묶음으로 봅니다. 이 구간에는 진입하지 않습니다.',
    }),
    correlationThreshold: z.number().min(0.1).max(0.95).default(0.5).meta({
      title: '역상관 판정 기준',
      description:
        '상관계수가 이 값보다 강하게 반대(-)면 같은 묶음으로 봅니다. 같은 묶음에서는 한 종목만 보유합니다.',
    }),
  })
  .refine((value) => value.fastEmaBars < value.slowEmaBars, {
    message: '단기 이동평균 봉 수는 장기보다 작아야 합니다',
    path: ['fastEmaBars'],
  });

export type EmaTrendSwitchParameters = z.infer<typeof emaTrendSwitchParameters>;

interface SymbolState {
  fast: EmaState;
  slow: EmaState;
  atr: AtrState;
  holding: HoldingState;
}

export interface EmaTrendSwitchState {
  readonly bySymbol: Map<string, SymbolState>;
  readonly symbols: readonly string[];
  groupOf: Map<string, string> | null;
  /** 마지막으로 그룹을 계산한 활성 심볼 집합 */
  groupedSymbolsKey: string | null;
  /** 종료 진단에 쓰는 마지막 활성 심볼 집합 */
  lastActiveSymbols: readonly string[];
  /** 마지막 그룹 계산 시점에 correlationBars 를 채운 활성 심볼 수 */
  groupReadyCount: number;
  /** 상관 계산용 종가 누적 — 동적 유니버스에서는 제한된 크기로 유지한다 */
  warmup: CorrelationWarmup | null;
}

function getSymbolState(state: EmaTrendSwitchState, symbol: string): SymbolState {
  let symbolState = state.bySymbol.get(symbol);
  if (!symbolState) {
    symbolState = { fast: newEma(), slow: newEma(), atr: newAtr(), holding: newHolding() };
    state.bySymbol.set(symbol, symbolState);
  }
  return symbolState;
}

/** 워밍업 미충족이면 null — 진입 판단 불가를 0 으로 위장하지 않는다 */
function spreadPercent(symbolState: SymbolState, slowEmaBars: number): number | null {
  if (
    symbolState.fast.value === null ||
    symbolState.slow.value === null ||
    symbolState.slow.barsSeen < slowEmaBars ||
    symbolState.slow.value <= 0
  ) {
    return null;
  }
  return ((symbolState.fast.value - symbolState.slow.value) / symbolState.slow.value) * 100;
}

function activeSymbols(
  context: StrategyBarContext,
  state: EmaTrendSwitchState,
): readonly string[] {
  if (context.activeUniverseSymbols === null) return state.symbols;
  return state.symbols.filter((symbol) => context.activeUniverseSymbols?.has(symbol) === true);
}

export const emaTrendSwitchStrategy: TradingStrategy<
  EmaTrendSwitchParameters,
  EmaTrendSwitchState
> = {
  id: 'ema-trend-switch',
  version: '1.0.2',
  name: 'EMA 추세 스위치',
  description:
    '단기·장기 이동평균 간격이 벌어진 종목에 올라타고, 고점에서 변동성 폭만큼 내려오면 팝니다. ' +
    '반대로 움직이는 종목(예: 레버리지·인버스 쌍)을 함께 넣으면 같은 묶음에서 한 종목만 보유해 ' +
    '방향 전환이 종목 교체로 표현됩니다.',
  parameterSchema: emaTrendSwitchParameters,
  dataRequirements: {
    priceWarmupBars: (parameters) => Math.max(
      parameters.slowEmaBars,
      parameters.atrPeriod + 1,
      parameters.correlationBars,
    ),
    requiresCorporateActions: true,
  },

  initialize(context: StrategyInitializeContext): EmaTrendSwitchState {
    return {
      bySymbol: new Map(),
      symbols: [...context.symbols].sort(),
      groupOf: null,
      groupedSymbolsKey: null,
      lastActiveSymbols: [],
      groupReadyCount: 0,
      warmup: newCorrelationWarmup(),
    };
  },

  onBars(
    context: StrategyBarContext,
    state: EmaTrendSwitchState,
    parameters: EmaTrendSwitchParameters,
  ): StrategyDecision {
    const orders: OrderIntent[] = [];
    // 심볼 사전순 고정 — 같은 봉에서 여러 종목이 신호를 내도 순서가 재현된다
    const sortedBars = [...context.bars.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const barSymbols = sortedBars.map(([symbol]) => symbol);

    // 1) 지표 갱신 + 상관 워밍업 누적 (봉 시각과 함께 — pair-groups.ts 참고)
    for (const [symbol, bar] of sortedBars) {
      const symbolState = getSymbolState(state, symbol);
      updateEma(symbolState.fast, bar.close, parameters.fastEmaBars);
      updateEma(symbolState.slow, bar.close, parameters.slowEmaBars);
      updateAtr(symbolState.atr, bar, parameters.atrPeriod);
      if (state.warmup !== null) recordClose(state.warmup, symbol, bar.tsMs, bar.close);
    }

    // 2) 현재 활성 멤버십의 그룹 확정. 새 종목이 충분한 이력을 채우거나 멤버십이
    //    바뀌면 다시 계산한다. 짧은 이력 종목 하나는 준비된 종목을 막지 않는다.
    const currentSymbols = activeSymbols(context, state);
    state.lastActiveSymbols = currentSymbols;
    if (state.warmup !== null) {
      pruneWarmupCloses(state.warmup, parameters.correlationBars * 2 + 14);
      const groupedSymbolsKey = currentSymbols.join('\u0000');
      const readyCount = currentSymbols.filter(
        (symbol) =>
          (state.warmup?.closesBySymbol.get(symbol)?.size ?? 0) >= parameters.correlationBars,
      ).length;
      const membershipChanged = groupedSymbolsKey !== state.groupedSymbolsKey;
      if (
        state.groupOf === null ||
        membershipChanged ||
        context.isRebalanceBar ||
        readyCount > state.groupReadyCount
      ) {
        const groupOf = tryBuildGroups(
          state.warmup,
          currentSymbols,
          parameters.correlationBars,
          parameters.correlationThreshold,
        );
        if (groupOf !== null) {
          state.groupOf = groupOf;
          state.groupedSymbolsKey = groupedSymbolsKey;
          state.groupReadyCount = readyCount;
          // 일정이 없는 정적 실행은 전 종목 준비 뒤 재계산할 이유가 없다.
          if (context.tradableSymbols === null && readyCount === state.symbols.length) {
            state.warmup = null;
          }
        } else if (membershipChanged) {
          state.groupOf = null;
          state.groupedSymbolsKey = groupedSymbolsKey;
          state.groupReadyCount = readyCount;
        }
      }
    }

    // 3) 청산 — 보유 종목만
    for (const [symbol, bar] of sortedBars) {
      const symbolState = getSymbolState(state, symbol);
      const position = context.portfolio.positions.get(symbol);

      if (!position || position.quantity <= 0) {
        symbolState.holding.exitPending = false;
        continue;
      }

      symbolState.holding.pendingEntry = false;
      symbolState.holding.barsHeld += 1;
      if (symbolState.holding.exitPending) continue;

      if (symbolState.holding.stopLevel === null) {
        confirmEntry(symbolState.holding, position.avgEntryPrice, parameters.stopAtrMultiplier);
      }
      updateTrail(symbolState.holding, bar.close, parameters.trailAtrMultiplier);

      const spread = spreadPercent(symbolState, parameters.slowEmaBars);
      const stop = symbolState.holding.stopLevel;
      // 진입가 위에서 걸린 트레일링 스톱은 손절이 아니라 이익 확정이다 —
      // TRAIL_STOP 으로 구분해야 거래 내역이 수익 청산을 손절로 표기하지 않는다
      const reason =
        stop !== null && bar.close < stop
          ? bar.close > position.avgEntryPrice
            ? 'TRAIL_STOP'
            : 'STOP'
          : spread !== null && spread <= 0
            ? 'TREND_END'
            : holdLimitReached(symbolState.holding, parameters.maxHoldBars)
              ? 'TIME'
              : null;
      if (reason !== null) {
        orders.push({ symbol, side: 'SELL', quantity: position.quantity, reason });
        symbolState.holding.exitPending = true;
      }
    }

    // 4) 진입 — 그룹 확정 전에는 진입하지 않는다
    if (state.groupOf !== null) {
      const groupOf = state.groupOf;
      // 보유·진입 대기 중인 그룹 선점 — 같은 봉에서 역상관 짝이 둘 다 신호를 내도
      // 사전순 첫 종목만 통과한다
      const claimed = new Set<string>();
      for (const symbol of currentSymbols) {
        const position = context.portfolio.positions.get(symbol);
        const holding = state.bySymbol.get(symbol)?.holding;
        if ((position && position.quantity > 0) || holding?.pendingEntry === true) {
          claimed.add(groupOf.get(symbol) ?? symbol);
        }
      }

      for (const symbol of barSymbols) {
        const symbolState = getSymbolState(state, symbol);
        if (context.tradableSymbols !== null && !context.tradableSymbols.has(symbol)) {
          symbolState.holding.pendingEntry = false;
          continue;
        }
        const position = context.portfolio.positions.get(symbol);
        if (position && position.quantity > 0) continue;

        // 미체결 진입 주문이 있었으면 이번 봉은 재평가만 — 중복 진입 금지
        if (symbolState.holding.pendingEntry) {
          symbolState.holding.pendingEntry = false;
          continue;
        }

        const group = groupOf.get(symbol) ?? symbol;
        if (claimed.has(group)) continue;

        const spread = spreadPercent(symbolState, parameters.slowEmaBars);
        if (spread === null || spread < parameters.entryThresholdPercent) continue;
        if (symbolState.atr.atr === null || symbolState.atr.barsSeen <= parameters.atrPeriod) {
          continue;
        }

        const quantity = riskQuantity(
          context.portfolio.equity,
          parameters.riskPerTradePercent,
          parameters.stopAtrMultiplier * symbolState.atr.atr,
        );
        if (quantity < 1) continue;

        orders.push({ symbol, side: 'BUY', quantity, reason: 'TREND' });
        symbolState.holding = newHolding();
        symbolState.holding.pendingEntry = true;
        symbolState.holding.entryAtr = symbolState.atr.atr;
        claimed.add(group);
      }
    }

    return { orders };
  },

  completionWarnings(state, parameters) {
    if (state.groupOf !== null) return [];
    const symbols = state.lastActiveSymbols.length > 0 ? state.lastActiveSymbols : state.symbols;
    const maxBars = Math.max(
      0,
      ...symbols.map((symbol) => state.warmup?.closesBySymbol.get(symbol)?.size ?? 0),
    );
    return [
      `EMA 추세 스위치: 상관 그룹 워밍업 부족 (필요 ${parameters.correlationBars}봉, `
        + `확보 최대 ${maxBars}봉). 워밍업 중에는 신규 진입을 평가하지 않습니다.`,
    ];
  },

  // 분할 등 자본변동이 걸린 종목의 가격 상태를 같은 비율로 내린다.
  // `ratio` 와 호출 시점은 엔진이 정한다(`engine.ts` 조정 루프 참고).
  //
  // 보유 상태만 고치면 부족하다.
  // 두 EMA 와 ATR 은 분할 전 가격대에 그대로 남아 다음 봉과 단위가 어긋난다.
  // 특히 `fast` 가 `slow` 보다 빨리 내려가 없던 하락 추세를 만든다.
  // 그러면 이 전략이 분할 봉에서 `TREND_END` 로 허위 청산한다.
  // 각 필드를 왜 나누는지는 지표별 `scale*` 함수 주석에 적었다.
  onCorporateAction(symbol, ratio, state) {
    const symbolState = state.bySymbol.get(symbol);
    if (symbolState !== undefined) {
      scaleEma(symbolState.fast, ratio);
      scaleEma(symbolState.slow, ratio);
      scaleAtr(symbolState.atr, ratio);
      scaleHoldingPrices(symbolState.holding, ratio);
    }
    // 동적 그룹 재계산용 워밍업에도 분할 전 종가가 쌓여 있을 수 있다
    if (state.warmup !== null) scaleWarmupCloses(state.warmup, symbol, ratio);
  },
};
