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
  newRsi,
  rsiValue,
  updateAtr,
  updateRsi,
  type AtrState,
  type RsiState,
} from './shared/indicators.js';
import {
  newCorrelationWarmup,
  recordClose,
  tryBuildGroups,
  type CorrelationWarmup,
} from './shared/pair-groups.js';
import { riskQuantity } from './shared/position-sizing.js';
import {
  confirmEntry,
  holdLimitReached,
  newHolding,
  type HoldingState,
} from './shared/trailing-stop.js';

/**
 * RSI 되돌림 (설계 2026-07-30-swing-strategies-design.md §4).
 *
 * RSI 과매도에 사서 RSI 회복에 판다. 스톱은 고정(트레일링 아님) — 되돌림 전략은
 * 진입 후 흔들림을 어느 정도 견뎌야 한다. 상관 그룹·수량 산정·보유 상한은
 * ema-trend-switch 와 같은 부품을 쓴다.
 */
export const rsiReversionParameters = z
  .object({
    rsiPeriod: z.number().int().min(2).max(100).default(14).meta({
      title: 'RSI 계산 기간',
      description: '과매도·회복을 재는 RSI 의 봉 수입니다. 짧으면 민감하고 잦은 신호가 납니다.',
    }),
    entryRsi: z.number().min(5).max(45).default(30).meta({
      title: '진입 RSI',
      description: 'RSI 가 이 값 이하로 내려간 종목을 삽니다. 낮게 잡을수록 깊은 과매도만 잡습니다.',
    }),
    exitRsi: z.number().min(50).max(95).default(55).meta({
      title: '청산 RSI',
      description: '보유 중 RSI 가 이 값 이상으로 회복하면 팝니다.',
    }),
    atrPeriod: z.number().int().min(2).max(100).default(14).meta({
      title: '변동성(ATR) 계산 기간',
      description: '손절 폭과 주문 수량의 기준이 되는 변동성을 몇 개 봉으로 평균낼지 정합니다.',
    }),
    stopAtrMultiplier: z.number().positive().max(20).default(2).meta({
      title: '손절 폭 (변동성 배수)',
      description:
        '진입가에서 변동성 × 이 값만큼 내려가면 손절합니다. 고정 손절선이며 고점을 따라 움직이지 않습니다.',
    }),
    maxHoldBars: z.number().int().min(1).max(10_000).optional().meta({
      title: '최대 보유 봉 수 (선택)',
      description:
        '이 봉 수를 넘기면 신호와 무관하게 팝니다. 분봉이면 390이 약 하루, 일봉이면 20이 약 1달입니다. 비우면 제한이 없습니다.',
    }),
    riskPerTradePercent: z.number().positive().max(5).default(1).meta({
      title: '1회 거래 리스크 (%)',
      description: '한 번의 거래에서 감당할 자본 비율입니다. 주문 수량 = 자본 × 이 비율 ÷ 손절 폭.',
    }),
    correlationBars: z.number().int().min(20).max(500).default(60).meta({
      title: '상관 계산 봉 수',
      description:
        '이 봉 수가 쌓이면 종목간 상관을 한 번 계산해 반대로 움직이는 종목들을 한 묶음으로 봅니다. 이 구간에는 진입하지 않습니다.',
    }),
    correlationThreshold: z.number().min(0.1).max(0.95).default(0.5).meta({
      title: '역상관 판정 기준',
      description:
        '상관계수가 이 값보다 강하게 반대(-)면 같은 묶음으로 봅니다. 같은 묶음에서는 한 종목만 보유합니다.',
    }),
  })
  .refine((value) => value.entryRsi < value.exitRsi, {
    message: '진입 RSI 는 청산 RSI 보다 작아야 합니다',
    path: ['entryRsi'],
  });

export type RsiReversionParameters = z.infer<typeof rsiReversionParameters>;

interface SymbolState {
  rsi: RsiState;
  atr: AtrState;
  holding: HoldingState;
}

export interface RsiReversionState {
  readonly bySymbol: Map<string, SymbolState>;
  readonly symbols: readonly string[];
  groupOf: Map<string, string> | null;
  /** 상관 계산용 종가 누적 — 그룹 확정 후 null 로 비운다 */
  warmup: CorrelationWarmup | null;
}

function getSymbolState(state: RsiReversionState, symbol: string): SymbolState {
  let symbolState = state.bySymbol.get(symbol);
  if (!symbolState) {
    symbolState = { rsi: newRsi(), atr: newAtr(), holding: newHolding() };
    state.bySymbol.set(symbol, symbolState);
  }
  return symbolState;
}

export const rsiReversionStrategy: TradingStrategy<RsiReversionParameters, RsiReversionState> = {
  id: 'rsi-reversion',
  version: '1.0.0',
  name: 'RSI 되돌림',
  description:
    'RSI 과매도 종목을 사서 RSI 가 회복하면 팝니다. 반대로 움직이는 종목(예: 레버리지·인버스 쌍)을 ' +
    '함께 넣으면 같은 묶음에서 한 종목만 보유합니다.',
  parameterSchema: rsiReversionParameters,

  initialize(context: StrategyInitializeContext): RsiReversionState {
    return {
      bySymbol: new Map(),
      symbols: [...context.symbols].sort(),
      groupOf: null,
      warmup: newCorrelationWarmup(),
    };
  },

  onBars(
    context: StrategyBarContext,
    state: RsiReversionState,
    parameters: RsiReversionParameters,
  ): StrategyDecision {
    const orders: OrderIntent[] = [];
    // 심볼 사전순 고정 — 같은 봉에서 여러 종목이 신호를 내도 순서가 재현된다
    const sortedBars = [...context.bars.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const barSymbols = sortedBars.map(([symbol]) => symbol);

    // 1) 지표 갱신 + 상관 워밍업 누적 (봉 시각과 함께 — pair-groups.ts 참고)
    for (const [symbol, bar] of sortedBars) {
      const symbolState = getSymbolState(state, symbol);
      updateRsi(symbolState.rsi, bar.close, parameters.rsiPeriod);
      updateAtr(symbolState.atr, bar, parameters.atrPeriod);
      if (state.warmup !== null) recordClose(state.warmup, symbol, bar.tsMs, bar.close);
    }

    // 2) 그룹 확정 (ema-trend-switch 와 동일한 규칙 — 전 종목 공통 봉이 쌓이면 1회).
    //    미확정의 의미(진입 영영 없음·경고 없음)는 tryBuildGroups 주석 참고.
    if (state.groupOf === null && state.warmup !== null) {
      const groupOf = tryBuildGroups(
        state.warmup,
        state.symbols,
        parameters.correlationBars,
        parameters.correlationThreshold,
      );
      if (groupOf !== null) {
        state.groupOf = groupOf;
        state.warmup = null;
      }
    }

    // 3) 청산
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

      const rsi = rsiValue(symbolState.rsi);
      const stop = symbolState.holding.stopLevel;
      const reason =
        rsi !== null && rsi >= parameters.exitRsi
          ? 'RSI_EXIT'
          : stop !== null && bar.close < stop
            ? 'STOP'
            : holdLimitReached(symbolState.holding, parameters.maxHoldBars)
              ? 'TIME'
              : null;
      if (reason !== null) {
        orders.push({ symbol, side: 'SELL', quantity: position.quantity, reason });
        symbolState.holding.exitPending = true;
      }
    }

    // 4) 진입
    if (state.groupOf !== null) {
      const groupOf = state.groupOf;
      const claimed = new Set<string>();
      for (const symbol of state.symbols) {
        const position = context.portfolio.positions.get(symbol);
        const holding = state.bySymbol.get(symbol)?.holding;
        if ((position && position.quantity > 0) || holding?.pendingEntry === true) {
          claimed.add(groupOf.get(symbol) ?? symbol);
        }
      }

      for (const symbol of barSymbols) {
        const symbolState = getSymbolState(state, symbol);
        const position = context.portfolio.positions.get(symbol);
        if (position && position.quantity > 0) continue;

        if (symbolState.holding.pendingEntry) {
          symbolState.holding.pendingEntry = false;
          continue;
        }

        const group = groupOf.get(symbol) ?? symbol;
        if (claimed.has(group)) continue;

        const rsi = rsiValue(symbolState.rsi);
        if (rsi === null || rsi > parameters.entryRsi) continue;
        if (symbolState.atr.atr === null || symbolState.atr.barsSeen <= parameters.atrPeriod) {
          continue;
        }

        const quantity = riskQuantity(
          context.portfolio.equity,
          parameters.riskPerTradePercent,
          parameters.stopAtrMultiplier * symbolState.atr.atr,
        );
        if (quantity < 1) continue;

        orders.push({ symbol, side: 'BUY', quantity, reason: 'REVERSION' });
        symbolState.holding = newHolding();
        symbolState.holding.pendingEntry = true;
        symbolState.holding.entryAtr = symbolState.atr.atr;
        claimed.add(group);
      }
    }

    return { orders };
  },
};
