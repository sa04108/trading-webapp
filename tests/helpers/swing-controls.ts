// 주문·수집 생명주기 픽스처는 짧은 봉으로 검증하므로 추세·유동성 필터와 분리한다.
export const UNFILTERED_BREAKOUT_CONTROLS = {
  trendSmaBars: 0,
  minAverageTradingValueKrw: 0,
  cooldownBars: 0,
  breakoutBufferAtr: 0,
  lookbackBars: 20,
};
