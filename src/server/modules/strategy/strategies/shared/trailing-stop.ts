/**
 * 보유 상태 한 벌 — 진입 대기(pendingEntry)·청산 대기(exitPending)·스톱 레벨·
 * 보유 봉 수를 들고 다닌다. hourly-breakout 의 관례를 따르되 공용으로 새로 작성:
 * 스톱은 신호봉 종가가 아니라 **실제 체결가** 기준으로 고정한다 (갭 진입 대응).
 *
 * 트레일링은 updateTrail 을 부르는 전략만 쓴다 — rsi-reversion 처럼 고정 스톱
 * 전략은 confirmEntry 만 부른다.
 */
export interface HoldingState {
  /** 신호 시점 ATR — 체결 확인 후 스톱 폭 계산에 쓰인다 */
  entryAtr: number | null;
  stopLevel: number | null;
  highestClose: number | null;
  barsHeld: number;
  pendingEntry: boolean;
  exitPending: boolean;
}

export function newHolding(): HoldingState {
  return {
    entryAtr: null,
    stopLevel: null,
    highestClose: null,
    barsHeld: 0,
    pendingEntry: false,
    exitPending: false,
  };
}

/** 체결이 확인된 첫 봉에 호출 — 실제 진입가 기준으로 스톱을 고정한다 */
export function confirmEntry(
  holding: HoldingState,
  avgEntryPrice: number,
  stopAtrMultiplier: number,
): void {
  if (holding.entryAtr === null) return;
  holding.stopLevel = avgEntryPrice - stopAtrMultiplier * holding.entryAtr;
  holding.highestClose = avgEntryPrice;
}

/** 종가가 고점을 갱신하면 스톱을 (고점 − trail×ATR) 까지 끌어올린다. 내리지는 않는다 */
export function updateTrail(
  holding: HoldingState,
  close: number,
  trailAtrMultiplier: number,
): void {
  if (holding.entryAtr === null || holding.stopLevel === null) return;
  if (holding.highestClose === null || close > holding.highestClose) {
    holding.highestClose = close;
    holding.stopLevel = Math.max(
      holding.stopLevel,
      holding.highestClose - trailAtrMultiplier * holding.entryAtr,
    );
  }
}

/** maxHoldBars 미지정이면 무제한 */
export function holdLimitReached(
  holding: HoldingState,
  maxHoldBars: number | undefined,
): boolean {
  return maxHoldBars !== undefined && holding.barsHeld >= maxHoldBars;
}
