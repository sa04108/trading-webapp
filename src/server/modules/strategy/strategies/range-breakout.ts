import { z } from 'zod';
import type { OrderIntent } from '../../backtest/domain/types.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  TradingStrategy,
} from '../domain/strategy.js';
import {
  newAtr,
  newRollingMax,
  pushRollingMax,
  rollingMaxValue,
  scaleAtr,
  scaleRollingMax,
  updateAtr,
  type AtrState,
  type RollingMaxState,
} from './shared/indicators.js';
import { riskQuantity, weightCappedQuantity } from './shared/position-sizing.js';
import {
  confirmEntry,
  holdLimitReached,
  newHolding,
  scaleHoldingPrices,
  updateTrail,
  type HoldingState,
} from './shared/trailing-stop.js';

/**
 * 전고점 돌파 (스펙 §32).
 *
 * 직전 N개 봉이 만든 고가 상단을 종가가 넘어서면 사고, 추적 손절·익절·보유 상한으로
 * 판다. 모든 창이 봉 수라 분봉·시간봉·일봉에서 같은 로직이다 — 파라미터의 의미가
 * 데이터셋에서 고른 봉 주기에 따라 달라진다(20봉은 1분봉이면 20분, 일봉이면 1달).
 *
 * ## 손절의 의미 — 실제 스톱 주문이 아니다
 *
 * 손절·익절은 **종가**로만 판정하고 다음 봉 시가에 체결한다. 장중에 손절선을 크게
 * 뚫었다가 종가가 회복한 봉은 청산되지 않는다 — 실제 스톱 주문이라면 손실이
 * 확정됐을 자리다. 즉 이 백테스트의 손절은 실전보다 **낙관적**이다. 체결 시점이
 * `NEXT_BAR_OPEN` 리터럴로 고정돼 있어(backtest-request.ts) 장중 체결을 표현할
 * 수 없기 때문이며, 파라미터 이름이 아니라 이 주석이 실제 동작이다.
 *
 * ## 이 전략의 이력 (D-028)
 *
 * `hourly-breakout`("시간봉 돌파", v1.2.0)이 전신이다. 이름이 시간봉에 묶여 있었지만
 * 로직은 처음부터 봉 수 기반이었고, 데이터셋이 분봉·시간봉·일봉을 모두 고를 수 있게
 * 되면서 이름이 사실과 어긋났다. 같은 개편에서 봉마다 `getHistory()` 전체를 복사하던
 * 돌파 기준선 계산(봉 수의 제곱)을 고정 길이 창으로 바꾸고, 추적 손절·보유 상한·
 * 명목 비중 상한을 더했다. id 가 바뀌었으므로 과거 `hourly-breakout` 실행은 화면에서
 * 원본 id 로 표시되며 「재설정 및 복제」 시 전략을 다시 골라야 한다.
 */
// 기본값은 스키마에 선언한다 — JSON 스키마의 `default` 로 노출되어 위저드가 그대로
// 읽는다. 클라이언트에 별도 기본값 사본을 두지 않는다. 한국어 라벨·설명도 같은
// 원칙으로 `.meta()` 에 둔다. 재현성 해시는 이 두 필드를 제외한다
// (strategySourceHash — 문구만 고쳐도 "전략 변경" 으로 보이면 안 된다).
export const rangeBreakoutParameters = z.object({
  lookbackBars: z.number().int().min(2).max(200).default(20).meta({
    title: '돌파 기준 봉 수',
    description:
      '직전 N개 봉의 최고가를 넘어서면 매수 진입합니다. 크게 잡으면 큰 추세만 잡아 신호가 줄고, 작게 잡으면 신호가 잦아지되 잔신호가 늘어납니다. 일봉 기준으로 20이면 약 1달입니다.',
  }),
  atrPeriod: z.number().int().min(2).max(100).default(14).meta({
    title: '변동성(ATR) 계산 기간',
    description:
      '손절·익절 폭의 기준이 되는 변동성을 몇 개 봉으로 평균낼지 정합니다. 짧으면 최근 변동에 민감하고, 길면 완만해집니다. Wilder 방식으로 계산합니다.',
  }),
  stopAtrMultiplier: z.number().positive().max(20).default(2).meta({
    title: '손절 폭 (변동성 배수)',
    description:
      '진입가에서 변동성(ATR) × 이 값만큼 내려가면 손절합니다. 주문 수량 계산에도 쓰이므로, 작게 잡으면 자주 잘리는 대신 수량이 커집니다. 종가로만 판정하므로 장중에 이 선을 뚫었다가 회복한 봉은 청산되지 않습니다.',
  }),
  trailAtrMultiplier: z.number().positive().max(20).default(2).meta({
    title: '추적 손절 폭 (변동성 배수)',
    description:
      '보유 중 종가가 고점을 갱신하면 손절선을 (고점 − 변동성 × 이 값)까지 끌어올립니다. 손절선은 내려가지 않습니다. 크게 잡으면 흔들림을 견디고, 작게 잡으면 이익을 빨리 확정합니다.',
  }),
  takeProfitAtrMultiplier: z.number().positive().max(50).optional().meta({
    title: '익절 폭 (변동성 배수)',
    description:
      '진입가에서 변동성(ATR) × 이 값만큼 오르면 익절합니다. 비워두면 추적 손절이 이익 확정을 맡습니다 — 추세를 끝까지 따라가려면 비워두세요.',
  }),
  // 라벨에 "(선택)" 을 쓰지 않는다 — 위저드가 optional 파라미터에 붙여준다
  maxHoldBars: z.number().int().min(1).max(10_000).optional().meta({
    title: '최대 보유 봉 수',
    description:
      '이 봉 수를 넘기면 신호와 무관하게 팝니다. 일봉 기준으로 20이면 약 1달입니다. 비우면 제한이 없습니다.',
  }),
  riskPerTradePercent: z.number().positive().max(5).default(1).meta({
    title: '1회 거래 리스크 (%)',
    description:
      '한 번의 거래에서 감당할 자본 비율입니다. 주문 수량 = 자본 × 이 비율 ÷ 손절 폭. 1% 로 두면 손절 시 자본의 약 1% 를 잃습니다.',
  }),
  maxPositionWeightPercent: z.number().min(1).max(100).default(20).meta({
    title: '종목당 비중 상한 (%)',
    description:
      '한 종목에 자본의 이 비율을 넘겨 넣지 않습니다. 변동성이 작은 종목은 리스크 기준 수량이 자본 전액을 넘어서는데, 그러면 현금이 말라 다른 종목을 살 수 없어 사실상 한 종목 올인이 됩니다. 100 으로 두면 상한이 없습니다.',
  }),
});

export type RangeBreakoutParameters = z.infer<typeof rangeBreakoutParameters>;

interface SymbolState {
  atr: AtrState;
  /** 직전 lookbackBars 개 봉의 고가 — 현재 봉은 판정 **후에** 넣는다 */
  priorHighs: RollingMaxState;
  holding: HoldingState;
}

export interface RangeBreakoutState {
  readonly bySymbol: Map<string, SymbolState>;
}

function getSymbolState(state: RangeBreakoutState, symbol: string): SymbolState {
  let symbolState = state.bySymbol.get(symbol);
  if (!symbolState) {
    symbolState = { atr: newAtr(), priorHighs: newRollingMax(), holding: newHolding() };
    state.bySymbol.set(symbol, symbolState);
  }
  return symbolState;
}

export const rangeBreakoutStrategy: TradingStrategy<RangeBreakoutParameters, RangeBreakoutState> = {
  id: 'range-breakout',
  version: '2.0.0',
  name: '전고점 돌파',
  description:
    '직전 N개 봉의 최고가를 종가가 넘어서면 사고, 고점을 따라 올라가는 손절선에 걸리면 팝니다. ' +
    '모든 창이 봉 수입니다 — 일봉 기준으로 돌파 기준 20봉은 약 1달입니다.',
  parameterSchema: rangeBreakoutParameters,

  initialize(): RangeBreakoutState {
    return { bySymbol: new Map() };
  },

  onBars(
    context: StrategyBarContext,
    state: RangeBreakoutState,
    parameters: RangeBreakoutParameters,
  ): StrategyDecision {
    const orders: OrderIntent[] = [];
    // 심볼 사전순 고정 — 같은 봉에서 여러 종목이 신호를 내도 순서가 재현된다
    const sortedBars = [...context.bars.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

    // 1) 지표 갱신. 돌파 기준선은 현재 봉을 창에 넣기 **전에** 읽는다 —
    //    그래야 종가가 자기 자신의 고가를 넘는 일이 구조적으로 불가능하다 (§9.1).
    const channelHighBySymbol = new Map<string, number | null>();
    for (const [symbol, bar] of sortedBars) {
      const symbolState = getSymbolState(state, symbol);
      channelHighBySymbol.set(
        symbol,
        rollingMaxValue(symbolState.priorHighs, parameters.lookbackBars),
      );
      pushRollingMax(symbolState.priorHighs, bar.high, parameters.lookbackBars);
      updateAtr(symbolState.atr, bar, parameters.atrPeriod);
    }

    // 2) 청산 — 보유 종목만
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

      // 체결이 확인된 시점에 **실제 진입가** 기준으로 레벨을 고정한다 — 갭 진입 시
      // 의도한 리스크 폭이 유지된다 (신호봉 종가 기준이면 갭만큼 어긋난다)
      if (symbolState.holding.stopLevel === null) {
        confirmEntry(symbolState.holding, position.avgEntryPrice, parameters.stopAtrMultiplier);
      }
      updateTrail(symbolState.holding, bar.close, parameters.trailAtrMultiplier);

      // 익절은 진입가 기준 고정 — 추적 손절과 달리 올라가지 않는다
      const takeProfit =
        parameters.takeProfitAtrMultiplier !== undefined && symbolState.holding.entryAtr !== null
          ? position.avgEntryPrice +
            parameters.takeProfitAtrMultiplier * symbolState.holding.entryAtr
          : null;

      const stop = symbolState.holding.stopLevel;
      // 진입가 위에서 걸린 손절선은 손절이 아니라 이익 확정이다 — TRAIL_STOP 으로
      // 구분해야 거래 내역이 수익 청산을 손절로 표기하지 않는다
      const reason =
        stop !== null && bar.close < stop
          ? bar.close > position.avgEntryPrice
            ? 'TRAIL_STOP'
            : 'STOP'
          : takeProfit !== null && bar.close > takeProfit
            ? 'TAKE_PROFIT'
            : holdLimitReached(symbolState.holding, parameters.maxHoldBars)
              ? 'TIME'
              : null;
      if (reason !== null) {
        orders.push({ symbol, side: 'SELL', quantity: position.quantity, reason });
        symbolState.holding.exitPending = true;
      }
    }

    // 3) 진입
    for (const [symbol, bar] of sortedBars) {
      const symbolState = getSymbolState(state, symbol);
      const position = context.portfolio.positions.get(symbol);
      if (position && position.quantity > 0) continue;

      // 미체결 진입 주문이 있었으면 이번 봉은 재평가만 — 중복 진입 금지
      if (symbolState.holding.pendingEntry) {
        symbolState.holding.pendingEntry = false;
        continue;
      }

      if (symbolState.atr.atr === null || symbolState.atr.barsSeen <= parameters.atrPeriod) {
        continue;
      }
      const channelHigh = channelHighBySymbol.get(symbol) ?? null;
      // 창이 아직 lookbackBars 개로 차지 않았으면 기준선이 없다 — 진입하지 않는다
      if (channelHigh === null) continue;
      if (bar.close <= channelHigh) continue;

      // 리스크 기준 수량과 명목 비중 상한의 min — 둘 중 하나만 쓰면 안 되는 이유는
      // position-sizing.ts 의 weightCappedQuantity 주석 참고
      const quantity = Math.min(
        riskQuantity(
          context.portfolio.equity,
          parameters.riskPerTradePercent,
          parameters.stopAtrMultiplier * symbolState.atr.atr,
        ),
        weightCappedQuantity(
          context.portfolio.equity,
          parameters.maxPositionWeightPercent,
          bar.close,
        ),
      );
      if (quantity < 1) continue;

      orders.push({ symbol, side: 'BUY', quantity, reason: 'BREAKOUT' });
      // 레벨은 여기서 정하지 않는다 — 체결 확인 후 실제 진입가 기준으로 계산 (갭 대응)
      symbolState.holding = newHolding();
      symbolState.holding.pendingEntry = true;
      symbolState.holding.entryAtr = symbolState.atr.atr;
    }

    return { orders };
  },

  // 분할 등 자본변동이 걸린 종목의 가격 상태를 같은 비율로 내린다.
  // `ratio` 와 호출 시점은 엔진이 정한다(`engine.ts` 조정 루프 참고).
  //
  // 돌파 기준선(`priorHighs`)이 이 전략의 핵심이다.
  // 내리지 않으면 기준선이 분할 전 고가에 남아 분할된 종가가 영영 못 넘는다.
  // 창이 새 가격으로 다 갈릴 때까지 진입이 막힌다.
  // 각 필드를 왜 나누는지는 지표별 `scale*` 함수 주석에 적었다.
  onCorporateAction(symbol, ratio, state) {
    const symbolState = state.bySymbol.get(symbol);
    if (symbolState === undefined) return;
    scaleRollingMax(symbolState.priorHighs, ratio);
    scaleAtr(symbolState.atr, ratio);
    scaleHoldingPrices(symbolState.holding, ratio);
  },
};
