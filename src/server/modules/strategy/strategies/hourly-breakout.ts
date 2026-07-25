import { z } from 'zod';
import type { Candle } from '../../market-data/domain/candle.js';
import type { OrderIntent } from '../../backtest/domain/types.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  TradingStrategy,
} from '../domain/strategy.js';

/**
 * 시간봉 돌파 기준 전략 (스펙 §32).
 * 수익성 검증용이 아니라 엔진의 정확성·재현성 검증용 기준 전략이다.
 *
 * 규칙:
 *  - 진입: 포지션이 없고, 종가가 직전 lookbackBars 개 봉의 최고 high 를 돌파하면 매수.
 *  - 수량: equity × riskPerTradePercent% ÷ (stopAtrMultiplier × ATR).
 *  - 청산: 종가 < 체결가 - stopAtrMultiplier × ATR(신호 시점), 또는
 *          takeProfitAtrMultiplier 가 있으면 종가 > 체결가 + tp × ATR.
 *    레벨은 신호봉 종가가 아니라 실제 체결가(다음 봉 시가 + 슬리피지) 기준이다 —
 *    갭 진입 시 의도한 리스크 폭이 유지된다.
 */
// 기본값(스펙 §15 예시)은 스키마에 선언한다 — JSON 스키마의 `default` 로 노출되어
// 위저드가 그대로 읽는다. 클라이언트에 별도 기본값 사본을 두지 않는다.
export const hourlyBreakoutParameters = z.object({
  lookbackBars: z.number().int().min(2).max(200).default(20),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  stopAtrMultiplier: z.number().positive().max(20).default(2),
  takeProfitAtrMultiplier: z.number().positive().max(50).optional(),
  riskPerTradePercent: z.number().positive().max(5).default(1),
});

export type HourlyBreakoutParameters = z.infer<typeof hourlyBreakoutParameters>;

interface SymbolState {
  /** Wilder ATR — 봉마다 갱신 */
  atr: number | null;
  prevClose: number | null;
  barsSeen: number;
  /** 신호 시점 ATR — 체결 확인 후 레벨 계산에 사용 */
  entryAtr: number | null;
  /** 보유 중 손절·익절 레벨 (체결 확인 시 실제 진입가 기준으로 고정) */
  stopLevel: number | null;
  takeProfitLevel: number | null;
  pendingEntry: boolean;
  /** 청산 주문 대기 중 — 체결 전까지 중복 청산 금지 */
  exitPending: boolean;
}

export interface HourlyBreakoutState {
  readonly bySymbol: Map<string, SymbolState>;
}

function updateAtr(state: SymbolState, bar: Candle, period: number): void {
  const trueRange =
    state.prevClose === null
      ? bar.high - bar.low
      : Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - state.prevClose),
          Math.abs(bar.low - state.prevClose),
        );
  state.atr =
    state.atr === null ? trueRange : (state.atr * (period - 1) + trueRange) / period;
  state.prevClose = bar.close;
  state.barsSeen += 1;
}

export const hourlyBreakoutStrategy: TradingStrategy<
  HourlyBreakoutParameters,
  HourlyBreakoutState
> = {
  id: 'hourly-breakout',
  version: '1.2.0',
  name: '시간봉 돌파',
  description:
    '직전 N개 시간봉 최고가 돌파 시 진입, ATR 기반 손절·익절. 엔진 검증용 기준 전략.',
  parameterSchema: hourlyBreakoutParameters,

  initialize(): HourlyBreakoutState {
    return { bySymbol: new Map() };
  },

  onBars(
    context: StrategyBarContext,
    state: HourlyBreakoutState,
    parameters: HourlyBreakoutParameters,
  ): StrategyDecision {
    const orders: OrderIntent[] = [];

    for (const [symbol, bar] of context.bars) {
      let symbolState = state.bySymbol.get(symbol);
      if (!symbolState) {
        symbolState = {
          atr: null,
          prevClose: null,
          barsSeen: 0,
          entryAtr: null,
          stopLevel: null,
          takeProfitLevel: null,
          pendingEntry: false,
          exitPending: false,
        };
        state.bySymbol.set(symbol, symbolState);
      }

      const history = context.getHistory(symbol);
      // history 는 현재 봉을 포함한다 — 직전 lookback 창은 현재 봉 제외
      const priorBars = history.slice(0, -1);

      updateAtr(symbolState, bar, parameters.atrPeriod);

      const position = context.portfolio.positions.get(symbol);

      if (position && position.quantity > 0) {
        symbolState.pendingEntry = false;
        if (symbolState.exitPending) continue;

        // 체결이 확인된 시점에 실제 진입가 기준으로 레벨을 고정한다
        if (symbolState.stopLevel === null && symbolState.entryAtr !== null) {
          symbolState.stopLevel =
            position.avgEntryPrice - parameters.stopAtrMultiplier * symbolState.entryAtr;
          symbolState.takeProfitLevel =
            parameters.takeProfitAtrMultiplier !== undefined
              ? position.avgEntryPrice +
                parameters.takeProfitAtrMultiplier * symbolState.entryAtr
              : null;
        }

        const stop = symbolState.stopLevel;
        const takeProfit = symbolState.takeProfitLevel;
        if (
          (stop !== null && bar.close < stop) ||
          (takeProfit !== null && bar.close > takeProfit)
        ) {
          orders.push({
            symbol,
            side: 'SELL',
            quantity: position.quantity,
            reason: stop !== null && bar.close < stop ? 'STOP' : 'TAKE_PROFIT',
          });
          symbolState.exitPending = true;
          symbolState.entryAtr = null;
          symbolState.stopLevel = null;
          symbolState.takeProfitLevel = null;
        }
        continue;
      }

      // 포지션 없음 — 직전 청산이 체결된 상태
      symbolState.exitPending = false;

      // 미체결 진입 주문이 있으면 중복 진입 금지
      if (symbolState.pendingEntry) {
        symbolState.pendingEntry = false; // 다음 봉에서 재평가
        continue;
      }

      if (
        symbolState.atr === null ||
        symbolState.barsSeen <= parameters.atrPeriod ||
        priorBars.length < parameters.lookbackBars
      ) {
        continue;
      }

      const lookbackWindow = priorBars.slice(-parameters.lookbackBars);
      const highestHigh = Math.max(...lookbackWindow.map((candle) => candle.high));

      if (bar.close > highestHigh) {
        const stopDistance = parameters.stopAtrMultiplier * symbolState.atr;
        if (stopDistance <= 0) continue;
        const riskBudget = context.portfolio.equity * (parameters.riskPerTradePercent / 100);
        const quantity = Math.floor(riskBudget / stopDistance);
        if (quantity < 1) continue;

        orders.push({ symbol, side: 'BUY', quantity, reason: 'BREAKOUT' });
        symbolState.pendingEntry = true;
        // 레벨은 여기서 정하지 않는다 — 체결 확인 후 실제 진입가 기준으로 계산 (갭 대응)
        symbolState.entryAtr = symbolState.atr;
        symbolState.stopLevel = null;
        symbolState.takeProfitLevel = null;
      }
    }

    return { orders };
  },
};
