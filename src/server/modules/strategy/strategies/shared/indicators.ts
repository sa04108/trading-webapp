/**
 * 증분 갱신형 지표. 상태 객체 + 순수 갱신 함수 — 전략이 심볼별로 상태를 들고
 * 봉마다 한 번 호출한다. 배열 재계산이 없어 봉 수에 선형이다.
 *
 * ATR 정의는 hourly-breakout 의 것과 동일(Wilder)하지만 그 파일에서 옮기지
 * 않았다 — 기존 전략 파일이 바뀌면 strategySourceHash 가 바뀐다.
 */

export interface EmaState {
  value: number | null;
  barsSeen: number;
}

export function newEma(): EmaState {
  return { value: null, barsSeen: 0 };
}

/** 첫 값으로 시딩, 이후 표준 지수평활 (alpha = 2/(bars+1)) */
export function updateEma(state: EmaState, price: number, bars: number): void {
  state.barsSeen += 1;
  if (state.value === null) {
    state.value = price;
    return;
  }
  const alpha = 2 / (bars + 1);
  state.value = state.value + alpha * (price - state.value);
}

export interface AtrState {
  atr: number | null;
  prevClose: number | null;
  barsSeen: number;
}

export function newAtr(): AtrState {
  return { atr: null, prevClose: null, barsSeen: 0 };
}

/** Wilder ATR — 첫 봉은 high−low, 이후 (prev×(n−1)+TR)/n */
export function updateAtr(
  state: AtrState,
  bar: { high: number; low: number; close: number },
  period: number,
): void {
  const trueRange =
    state.prevClose === null
      ? bar.high - bar.low
      : Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - state.prevClose),
          Math.abs(bar.low - state.prevClose),
        );
  state.atr = state.atr === null ? trueRange : (state.atr * (period - 1) + trueRange) / period;
  state.prevClose = bar.close;
  state.barsSeen += 1;
}

export interface RsiState {
  avgGain: number | null;
  avgLoss: number | null;
  prevClose: number | null;
  changesSeen: number;
  sumGain: number;
  sumLoss: number;
}

export function newRsi(): RsiState {
  return { avgGain: null, avgLoss: null, prevClose: null, changesSeen: 0, sumGain: 0, sumLoss: 0 };
}

/** Wilder RSI — 첫 period 개 변화는 단순평균으로 시딩, 이후 Wilder 평활 */
export function updateRsi(state: RsiState, close: number, period: number): void {
  if (state.prevClose === null) {
    state.prevClose = close;
    return;
  }
  const change = close - state.prevClose;
  state.prevClose = close;
  const gain = Math.max(change, 0);
  const loss = Math.max(-change, 0);
  state.changesSeen += 1;
  if (state.avgGain === null || state.avgLoss === null) {
    state.sumGain += gain;
    state.sumLoss += loss;
    if (state.changesSeen === period) {
      state.avgGain = state.sumGain / period;
      state.avgLoss = state.sumLoss / period;
    }
    return;
  }
  state.avgGain = (state.avgGain * (period - 1) + gain) / period;
  state.avgLoss = (state.avgLoss * (period - 1) + loss) / period;
}

/** 시딩 전(변화 < period)이면 null. avgLoss 0 이면 100. */
export function rsiValue(state: RsiState): number | null {
  if (state.avgGain === null || state.avgLoss === null) return null;
  if (state.avgLoss === 0) return 100;
  return 100 - 100 / (1 + state.avgGain / state.avgLoss);
}
