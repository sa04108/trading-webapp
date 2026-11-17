/** 재무 계산·종목 순위 테스트에서 시장/회전율 필터를 분리하는 명시적 설정이다. */
export const UNFILTERED_RANK_CONTROLS = {
  marketTrendBars: 0, riskOffExposurePercent: 100, investmentPercent: 100,
  minRebalanceBars: 1, rankBufferPercent: 0, rebalanceBandPercent: 0,
  liquidityLookbackBars: 2, minAverageTradingValueKrw: 0,
};

export const DEFAULT_RANK_CONTROLS = {
  marketTrendBars: 200, riskOffExposurePercent: 30, investmentPercent: 95,
  minRebalanceBars: 20, rankBufferPercent: 25, rebalanceBandPercent: 20,
  liquidityLookbackBars: 20, minAverageTradingValueKrw: 100_000_000,
};
