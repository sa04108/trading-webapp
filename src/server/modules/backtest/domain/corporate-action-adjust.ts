export interface AdjustResult {
  readonly quantity: number;
  readonly avgEntryPrice: number;
  /** 단주 잔여를 환산한 현금. ratio가 정수가 아니면 분할에서도 생긴다 */
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
  if (ratio < 0) {
    throw new Error(`Invalid ratio: ${ratio}. Ratio must be non-negative.`);
  }

  if (ratio === 0) {
    return {
      quantity: 0,
      avgEntryPrice: 0,
      cashFromFraction: 0,
      closed: true,
    };
  }

  const raw = quantity * ratio;
  // 부동소수점 오차 때문에 정수여야 할 값이 1e-9 정도의 오차를 가지고 나타난다.
  // ratio가 정수가 아닌 유리수(예: 3/11, 0.7)일 때 누적 오차가 생긴다.
  // 값이 가장 가까운 정수에서 1e-9 이내면 그 정수가 수학적 참값이다.
  // epsilon = 1e-9 는 보수적인 선택이다:
  // - 실제 오차는 typically 1e-15 ~ 1e-10
  // - 1e-9는 machine epsilon(~2.2e-16) 보다 훨씬 크지만 0.5보다는 훨씬 작아
  //   실제 단주를 놓치지 않는다
  const epsilon = 1e-9;
  const whole = Math.abs(raw - Math.round(raw)) < epsilon ? Math.round(raw) : Math.floor(raw);
  const fraction = raw - whole;

  return {
    quantity: whole,
    avgEntryPrice: avgEntryPrice / ratio,
    cashFromFraction: fraction * fractionPrice,
    closed: whole === 0,
  };
}
