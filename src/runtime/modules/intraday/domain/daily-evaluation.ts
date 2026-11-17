import { intradayDate, type IntradayResult } from "../../../../shared/schemas/intraday.js";
import type { IntradayDailyReport, IntradayDayEvaluation, IntradayDayStatus } from "../../../../shared/schemas/intraday-daily.js";
import type { RiskFreeRateHistory } from "../../../../shared/schemas/risk-free-rate.js";
import { computeSharpe } from "../../backtest/domain/sharpe.js";

/** 확인된 거래일과 실제 관측치를 대조한다. 누락·미실행을 무거래 수익률 0으로 바꾸지 않는다. */
export function buildIntradayDailyReport(
  result: Pick<IntradayResult, "request" | "equity" | "fills" | "position">,
  tradingDates: readonly string[],
  sessionMinutes: number,
  rates: RiskFreeRateHistory,
): IntradayDailyReport {
  const observations = new Map<string, { count: number; equity: number; quantity: number; peak: number; drawdown: number; openingEquity: number }>();
  let priorEquity = result.request.initialCash;
  for (const point of result.equity) {
    const date = intradayDate(point.endMs);
    let day = observations.get(date);
    if (!day) {
      day = { count: 0, equity: priorEquity, quantity: 0, peak: priorEquity, drawdown: 0, openingEquity: priorEquity };
      observations.set(date, day);
    }
    day.count++;
    day.equity = point.equity;
    day.quantity = point.quantity;
    day.peak = Math.max(day.peak, point.equity);
    day.drawdown = Math.min(day.drawdown, (point.equity / day.peak - 1) * 100);
    priorEquity = point.equity;
  }
  const fills = new Map<string, number>();
  for (const fill of result.fills) {
    const date = intradayDate(fill.atMs);
    fills.set(date, (fills.get(date) ?? 0) + 1);
  }
  const last = result.equity.at(-1);
  const earlyTermination = result.position.quantity > 0 && last
    ? { date: intradayDate(last.endMs), remainingQuantity: result.position.quantity }
    : null;
  const days: IntradayDayEvaluation[] = [...new Set(tradingDates)].sort().map((date) => {
    const day = observations.get(date);
    const status: IntradayDayStatus = earlyTermination && date > earlyTermination.date ? "NOT_RUN"
      : earlyTermination?.date === date ? "EXIT_FAILED"
      : !day ? "MISSING" : day.count < sessionMinutes ? "PARTIAL" : "COMPLETE";
    return {
      date, status, observedBars: day?.count ?? 0,
      missingMinutes: status === "NOT_RUN" ? 0 : Math.max(0, sessionMinutes - (day?.count ?? 0)),
      fillCount: fills.get(date) ?? 0, closingQuantity: day?.quantity ?? null,
      pnl: day ? day.equity - day.openingEquity : null,
      returnPct: day ? (day.equity / day.openingEquity - 1) * 100 : null,
      maxDrawdownPct: day?.drawdown ?? null,
    };
  });
  const evaluated = days.filter((day) => day.status === "COMPLETE");
  const returns = evaluated.map((day) => day.returnPct!);
  const sorted = [...returns].sort((a, b) => a - b);
  const count = evaluated.length;
  const mean = count ? returns.reduce((sum, value) => sum + value, 0) / count : null;
  const median = count ? count % 2 ? sorted[Math.floor(count / 2)]! : (sorted[count / 2 - 1]! + sorted[count / 2]!) / 2 : null;
  const standardDeviation = count > 1 ? Math.sqrt(returns.reduce((sum, value) => sum + (value - mean!) ** 2, 0) / (count - 1)) : null;
  const worst = evaluated.reduce<IntradayDayEvaluation | null>((value, day) => !value || day.returnPct! < value.returnPct! ? day : value, null);
  let streak = 0, maxStreak = 0;
  for (const day of days) {
    // 미관측일을 건너뛰어 서로 떨어진 손실일을 연속 손실로 합치지 않는다.
    streak = day.status === "COMPLETE" && day.returnPct! < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const profits = evaluated.filter((day) => day.pnl! > 0).map((day) => day.pnl!).sort((a, b) => b - a);
  const profitSum = profits.reduce((sum, value) => sum + value, 0);
  const sharpe = computeSharpe(evaluated.map((day) => ({ date: day.date, value: day.returnPct! / 100 })), rates);
  const statusCount = (status: IntradayDayStatus) => days.filter((day) => day.status === status).length;
  return {
    days, sharpeBasis: sharpe.sharpeBasis,
    summary: {
      isComplete: count === days.length && days.length > 0,
      expectedDays: days.length, evaluatedDays: count,
      partialDays: statusCount("PARTIAL"), missingDays: statusCount("MISSING"),
      notRunDays: statusCount("NOT_RUN"), exitFailedDays: statusCount("EXIT_FAILED"),
      activeDays: evaluated.filter((day) => day.fillCount > 0).length,
      profitableDays: profits.length,
      meanReturnPct: mean, medianReturnPct: median, standardDeviationPct: standardDeviation,
      profitableDayPct: count ? profits.length / count * 100 : null,
      worstReturnPct: worst?.returnPct ?? null, worstDate: worst?.date ?? null,
      sharpe: sharpe.sharpe, maxConsecutiveLossDays: maxStreak,
      worstIntradayDrawdownPct: count ? Math.min(...evaluated.map((day) => day.maxDrawdownPct!)) : null,
      top3ProfitSharePct: profitSum > 0 ? profits.slice(0, 3).reduce((sum, value) => sum + value, 0) / profitSum * 100 : null,
      earlyTermination,
    },
  };
}
