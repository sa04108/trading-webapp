import { describe, expect, it } from "vitest";
import { buildIntradayDailyReport } from "../../src/runtime/modules/intraday/domain/daily-evaluation.js";
import type { IntradayResult } from "../../src/shared/schemas/intraday.js";
import type { RiskFreeRateHistory } from "../../src/shared/schemas/risk-free-rate.js";
import { evaluateValidationCandidate } from "../../src/shared/schemas/period-validation.js";

const dates = ["02", "03", "04", "05", "06", "09", "10", "11"].map((day) => `2026-11-${day}`);
const rates: RiskFreeRateHistory = {
  series: "KRW_MSB_91D", source: "USER_CSV", sourceSha256: "a".repeat(64), version: "b".repeat(64),
  coveredFrom: dates[0]!, coveredTo: dates.at(-1)!, changes: [{ date: dates[0]!, annualRatePct: 2.52 }],
};
function input() {
  const equity: IntradayResult["equity"] = [], fills: IntradayResult["fills"] = [];
  let cash = 1000;
  for (const [i, rate] of [1, -2, 0, 3, -1, null, -1, 2].entries()) {
    if (rate === null) continue;
    const start = Date.parse(`${dates[i]}T09:00:00+09:00`), minutes = i === 7 ? 100 : 380;
    const closing = cash * (1 + rate / 100);
    for (let j = 1; j <= minutes; j++) equity.push({ endMs: start + j * 60_000, equity: j === minutes ? closing : cash, cash: j === minutes ? closing : cash, quantity: 0 });
    if (rate !== 0) fills.push({ orderId: `fill-${i}`, atMs: start + 60_000, signalAtMs: start, eligibleAtMs: start + 1, side: "SELL", qty: 1, price: 100, commission: 0, tax: 0, reason: "DAY_EXIT" });
    cash = closing;
  }
  return { request: { initialCash: 1000 } as IntradayResult["request"], equity, fills, position: { quantity: 0, averagePrice: 0, lastPrice: 100 } };
}

// 기존 엔진 체결 검사는 누락일과 정상 무거래일의 통계 분모, 불완전한 후보의 선택을 구분하지 않는다.
describe("분봉 일별 평가의 관측 범위", () => {
  it("누락·부분 관측일은 제외하고 정상 무거래일을 포함해 비용 차감 자산의 일별 통계를 계산한다", () => {
    const report = buildIntradayDailyReport(input(), dates, 380, rates);
    expect(report.days.map((day) => day.status)).toEqual(["COMPLETE", "COMPLETE", "COMPLETE", "COMPLETE", "COMPLETE", "MISSING", "COMPLETE", "PARTIAL"]);
    expect(report.days[5]).toMatchObject({ returnPct: null, pnl: null, missingMinutes: 380 });
    expect(report.days[7]).toMatchObject({ missingMinutes: 280 });
    expect(report.days[7]!.returnPct).toBeCloseTo(2);
    expect(report.summary).toMatchObject({ isComplete: false, expectedDays: 8, evaluatedDays: 6, partialDays: 1, missingDays: 1, activeDays: 5, profitableDays: 2, maxConsecutiveLossDays: 1, worstDate: dates[1], top3ProfitSharePct: 100 });
    expect(report.summary.meanReturnPct).toBeCloseTo(0);
    expect(report.summary.medianReturnPct).toBeCloseTo(-0.5);
    expect(report.summary.standardDeviationPct).toBeCloseTo(Math.sqrt(3.2));
    expect(report.summary.profitableDayPct).toBeCloseTo(100 / 3);
    expect(report.summary.worstIntradayDrawdownPct).toBeCloseTo(-2);
    expect(report.summary.sharpe).toBeCloseTo((-0.0252 / 252) / (Math.sqrt(3.2) / 100) * Math.sqrt(252));
    expect(report.sharpeBasis.observationCount).toBe(6);
  });
  it("실제 거래일 조건과 불완전한 기간을 구분하여 최적화 후보에서 제외한다", () => {
    const summary = buildIntradayDailyReport(input(), dates, 380, rates).summary;
    const optimization = { axes: [{ key: "fast", values: [2, 3] }], objective: "sharpe" as const, minTrades: 5, minTradingDays: 6, maxDrawdownPct: 30 };
    const metrics = { totalReturnPct: 5, cagrPct: null, sharpe: 2, maxDrawdownPct: -3, tradeCount: 100, intradayDaily: summary };
    expect(evaluateValidationCandidate(metrics, optimization)).toEqual({ eligible: false, reasons: ["INCOMPLETE_PERIOD", "INSUFFICIENT_TRADING_DAYS"] });
    expect(evaluateValidationCandidate({ ...metrics, intradayDaily: undefined }, optimization)).toEqual({ eligible: false, reasons: ["TRADING_DAYS_UNAVAILABLE"] });
    expect(evaluateValidationCandidate({ ...metrics, intradayDaily: { ...summary, isComplete: true, activeDays: 6 } }, optimization)).toEqual({ eligible: true, reasons: [] });
  });
});
