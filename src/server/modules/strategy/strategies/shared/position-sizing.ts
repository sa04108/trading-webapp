/**
 * 리스크 기반 수량: floor(equity × riskPct% ÷ stopDistance).
 * 변동성(ATR) 반비례라 2x 레버리지 상품은 수량이 자동으로 절반쯤 된다 —
 * 전략이 상품 유형을 몰라도 리스크가 일정해지는 이유.
 *
 * 여기서 낸 수량은 상한이다 — 현금이 부족하면 엔진이 감당 가능한 수량으로 줄여
 * 체결한다(hourly-breakout 과 같은 관례). 따라서 리스크 %는 실제값이 아닌 상한이다.
 */
export function riskQuantity(
  equity: number,
  riskPerTradePercent: number,
  stopDistance: number,
): number {
  if (!(equity > 0) || !(stopDistance > 0)) return 0;
  return Math.floor((equity * (riskPerTradePercent / 100)) / stopDistance);
}
