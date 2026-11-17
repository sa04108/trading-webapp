import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IntradayReproductionInfo } from "@/features/intraday/intraday-reproduction-info";
import type { IntradayRequest } from "../../src/shared/schemas/intraday";

const request: IntradayRequest = {
  mode: "intraday", strategyId: "intraday-ema", symbol: "005930",
  period: { from: "2026-01-05", to: "2026-03-31" }, timeframe: "5m", initialCash: 12345678,
  parameters: { fast: 7, slow: 19, allocationPct: 80, stopLossPct: 2.5, takeProfitPct: 4 },
  execution: { holdingPolicy: "DAY_ONLY", commissionBps: 1.5, taxBps: 20, slippageBps: 5, latencyMs: 1500, orderExpiryMinutes: 3, maxParticipationPct: 0.5 },
};
const render = (input: IntradayRequest) => renderToStaticMarkup(<TooltipProvider><IntradayReproductionInfo result={{
  request: input, strategyVersion: "0.9.0", dataRevision: "a".repeat(64), executionVersion: "b".repeat(64),
}} /></TooltipProvider>);

// 엔진·일반 숫자 포맷 검사는 표시 요율의 100배 오류나 과거 설정을 현재 기본값으로 바꾸는 문제를 잡지 못한다.
describe("분봉 재현 정보 해석", () => {
  it("저장된 전략 버전과 설정을 단위·적용 대상으로 읽을 수 있게 표시한다", () => {
    const html = render(request);
    for (const text of ["EMA 교차 · v0.9.0", "5분봉", "12,345,678원", "단기 EMA", "7봉", "19봉", "현재 현금의 80%", "평균 매수가 대비 −2.5%", "평균 매수가 대비 +4%", "당일 청산 시도", "수수료 (매수·매도)", "0.015% (1.5bp)", "세금 (매도)", "0.2% (20bp)", "0.05% (5bp)", "1.5초", "체결 가능 시각부터 3분", "1분봉 거래량의 0.5%"]) expect(html).toContain(text);
    for (const text of ["DAY_ONLY", "commissionBps", "holdingPolicy", "a".repeat(64), "b".repeat(64)]) expect(html).not.toContain(text);
  });

  it("소액 요율·최소 지연을 0으로 반올림하지 않고 0 요율도 누락하지 않는다", () => {
    const html = render({ ...request, execution: { ...request.execution, commissionBps: 0.00001, taxBps: 0, latencyMs: 1 } });
    expect(html).toContain("0.0000001% (0.00001bp)");
    expect(html).toContain("0% (0bp)");
    expect(html).toContain("0.001초");
  });

  it.each([
    ["intraday-orb", { openingMinutes: 20, entryWindowMinutes: 90, breakoutBps: 25, volumeMultiplier: 1.7, allocationPct: 95, stopLossPct: 1.5, takeProfitPct: 3 }, ["시초 범위", "20분", "90분", "0.25% (25bp)", "1.7배"]],
    ["intraday-vwap-reclaim", { trendPeriod: 17, volumePeriod: 8, volumeMultiplier: 1.3, allocationPct: 95, stopLossPct: 1.5, takeProfitPct: 3 }, ["추세 EMA", "17봉", "8봉", "1.3배"]],
    ["intraday-bollinger-rsi", { bandPeriod: 18, bandStdDev: 2.5, rsiPeriod: 12, oversold: 25, allocationPct: 95, stopLossPct: 1, takeProfitPct: 2 }, ["볼린저 기간", "18봉", "2.5배", "RSI 기간", "12봉", "과매도 RSI"]],
  ] as const)("%s 전략의 봉·시간·배수 단위를 구분한다", (strategyId, parameters, expected) => {
    const html = render({ ...request, strategyId, parameters } as IntradayRequest);
    for (const text of expected) expect(html).toContain(text);
  });
});
