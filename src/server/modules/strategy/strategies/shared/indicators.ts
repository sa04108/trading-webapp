/**
 * 증분 갱신형 지표. 상태 객체 + 순수 갱신 함수 — 전략이 심볼별로 상태를 들고
 * 봉마다 한 번 호출한다. 배열 재계산이 없어 봉 수에 선형이다.
 *
 * 등록된 전략은 전부 이 모듈만 쓴다. 봉마다 `getHistory()` 전체를 다시 훑으면
 * 봉 수의 제곱으로 커져 1분봉 구간(MAX_BACKTEST_BARS 2백만)을 완주할 수 없다.
 *
 * 여기서 계산 방식을 바꾸면 그 지표를 쓰는 **모든 전략의 동작이 바뀐다.**
 * `strategySourceHash` 는 소스가 아니라 `id + version + 파라미터 스키마` 해시라
 * (strategy-source-hash.ts) 이 파일 변경을 감지하지 못한다 — 호출하는 전략들의
 * `version` 을 직접 올려야 과거 실행과 구분된다.
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

/**
 * 최근 `window` 개 값의 최대 — 돌파 기준선(전고점)용 고정 길이 창.
 *
 * 전략은 **현재 봉을 창에 넣기 전에** 값을 읽어야 한다. 그래야 기준선이 현재 봉을
 * 포함하지 않고, 종가가 자기 자신의 고가를 넘는 일이 구조적으로 불가능해진다
 * (look-ahead 방지, 스펙 §9.1).
 */
export interface RollingMaxState {
  /** 오래된 것이 앞 — 길이는 window 이하로 유지된다 */
  readonly values: number[];
}

export function newRollingMax(): RollingMaxState {
  return { values: [] };
}

/** 창이 window 를 넘으면 가장 오래된 값을 버린다 */
export function pushRollingMax(state: RollingMaxState, value: number, window: number): void {
  state.values.push(value);
  while (state.values.length > window) state.values.shift();
}

/** 창이 아직 window 개로 차지 않았으면 null — 판단 불가를 값으로 위장하지 않는다 */
export function rollingMaxValue(state: RollingMaxState, window: number): number | null {
  if (state.values.length < window) return null;
  let max = state.values[0] as number;
  for (const value of state.values) if (value > max) max = value;
  return max;
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
