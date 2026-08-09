/**
 * 기간 종료일(YYYY-MM-DD)을 봉 tsMs 규약(그 거래일 UTC 자정)으로 바꾼다.
 * `lastPriceTsMs` 와 단위를 맞추지 않으면 끝까지 거래된 정상 종목도 "하루 경과"로
 * 보인다 — 봉의 UTC 자정 대신 KST 자정·23:59:59 등을 쓰면 반나절 가까이 어긋난다.
 */
export function periodEndTsMs(periodTo: string): number {
  return Date.parse(`${periodTo}T00:00:00Z`);
}

/** 마지막으로 가격을 확인한 날부터 기간 종료일까지의 일수 — 0이면 끝까지 거래된 종목이다 */
export function staleDays(lastPriceTsMs: number, periodEndTsMs: number): number {
  return Math.max(0, Math.round((periodEndTsMs - lastPriceTsMs) / 86_400_000));
}
