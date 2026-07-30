/**
 * 리스크 기반 수량: floor(equity × riskPct% ÷ stopDistance).
 * 변동성(ATR) 반비례라 2x 레버리지 상품은 수량이 자동으로 절반쯤 된다 —
 * 전략이 상품 유형을 몰라도 리스크가 일정해지는 이유.
 */
export function riskQuantity(
  equity: number,
  riskPerTradePercent: number,
  stopDistance: number,
): number {
  if (!(equity > 0) || !(stopDistance > 0)) return 0;
  return Math.floor((equity * (riskPerTradePercent / 100)) / stopDistance);
}
