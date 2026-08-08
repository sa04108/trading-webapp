export interface AdjustResult {
  readonly quantity: number;
  readonly avgEntryPrice: number;
  /** 단주 잔여를 환산한 현금. 분할(ratio > 1)에서는 항상 0 이다 */
  readonly cashFromFraction: number;
  /** 조정 후 수량이 0 이 되어 포지션을 닫아야 하는가 */
  readonly closed: boolean;
}

/**
 * 자본변동 하나를 포지션 하나에 적용한다.
 *
 * 수량 × 단가를 보존하는 것이 규칙이다. 미실현 손익이 자본변동만으로 변하면 안 된다.
 *
 * 역분할은 수량이 정수로 떨어지지 않는다. 실제 제도가 단주를 현금으로 정산하므로
 * 내림하고 잔여를 현금으로 돌린다. 반올림하면 없던 주식이 생긴다.
 *
 * `fractionPrice` 는 효력발생일 봉의 시가다. 그 봉은 이미 자본변동 후 가격이라
 * 따로 환산하지 않는다.
 */
export function adjustForRatio(
  quantity: number,
  avgEntryPrice: number,
  ratio: number,
  fractionPrice: number,
): AdjustResult {
  const raw = quantity * ratio;
  const whole = Math.floor(raw);
  const fraction = raw - whole;
  return {
    quantity: whole,
    avgEntryPrice: avgEntryPrice / ratio,
    cashFromFraction: fraction * fractionPrice,
    closed: whole === 0,
  };
}
