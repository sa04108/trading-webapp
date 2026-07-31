/**
 * 리스크 기반 수량: floor(equity × riskPct% ÷ stopDistance).
 * 변동성(ATR) 반비례라 2x 레버리지 상품은 수량이 자동으로 절반쯤 된다 —
 * 전략이 상품 유형을 몰라도 리스크가 일정해지는 이유.
 *
 * 여기서 낸 수량은 상한이다 — 현금이 부족하면 엔진이 감당 가능한 수량으로 줄여
 * 체결한다(engine.ts `executeOrder`). 따라서 리스크 %는 실제값이 아닌 상한이다.
 *
 * 이 함수만으로는 부족하다 — `weightCappedQuantity` 주석 참고.
 */
export function riskQuantity(
  equity: number,
  riskPerTradePercent: number,
  stopDistance: number,
): number {
  if (!(equity > 0) || !(stopDistance > 0)) return 0;
  return Math.floor((equity * (riskPerTradePercent / 100)) / stopDistance);
}

/**
 * 명목 비중 상한: floor(equity × maxWeightPct% ÷ price).
 *
 * `riskQuantity` 만 쓰면 저변동 종목에서 수량이 자본 전액을 넘어선다. ATR/가격이
 * 0.5% 인 종목에 리스크 1%·손절 2×ATR 을 적용하면 손절 폭이 가격의 1% 라
 * 수량 ≈ equity/price, 즉 전액 매수다. 그러면 엔진이 현금 부족으로 수량을 깎아
 * 체결하므로 **선언한 리스크 %도, 동시 보유 상한도 의미를 잃는다** — 자산 곡선은
 * 정상처럼 보이면서 사실상 한 종목 올인이 된다. 두 상한의 min 을 쓴다.
 *
 * `price` 는 신호봉 종가다. 실제 체결은 다음 봉 시가이므로 갭이 크면 결과 비중이
 * 상한을 넘을 수 있다 — 주문 시점 기준의 상한이며 사후 보정하지 않는다.
 */
export function weightCappedQuantity(
  equity: number,
  maxPositionWeightPercent: number,
  price: number,
): number {
  if (!(equity > 0) || !(price > 0)) return 0;
  return Math.floor((equity * (maxPositionWeightPercent / 100)) / price);
}
