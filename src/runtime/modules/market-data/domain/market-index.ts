/** 종목 주문 대상에 섞지 않는 확정 KOSPI 종가. 시각은 같은 날짜 일봉과 같은 UTC 기준이다. */
export interface MarketIndexPoint {
  readonly tsMs: number;
  readonly close: number;
}

export interface MarketIndexRequirement {
  readonly from: string;
  readonly to: string;
  readonly tradeFrom: string;
  readonly minimumBars: number;
}
