import type { RiskFreeRateHistory, SharpeBasis } from "../../../../shared/schemas/risk-free-rate.js";
import { annualRiskFreeRate } from "./risk-free-rate.js";

export interface DatedReturn { date: string; value: number }

/** 각 날짜의 연 이율을 일율로 차감하고 투자수익률의 표본 표준편차로 연율화한다. */
export function computeSharpe(
  dailyReturns: readonly DatedReturn[],
  history: RiskFreeRateHistory,
): { sharpe: number | null; sharpeBasis: SharpeBasis } {
  const rates = dailyReturns.map(({ date }) => annualRiskFreeRate(date, history));
  const known = rates.filter((value): value is number => value !== null);
  const averageRate = known.length ? known.reduce((sum, rate) => sum + rate, 0) / known.length : null;
  const sharpeBasis: SharpeBasis = {
    method: "DATED_RATE_CHANGES", convention: "DAILY_SAMPLE_SD_ANNUALIZED_252",
    series: history.series, source: history.source, historyVersion: history.version,
    coveredFrom: history.coveredFrom, coveredTo: history.coveredTo,
    observationCount: dailyReturns.length, missingRateDays: rates.length - known.length,
    averageAnnualRatePct: averageRate,
    minAnnualRatePct: known.length ? Math.min(...known) : null,
    maxAnnualRatePct: known.length ? Math.max(...known) : null,
  };
  if (dailyReturns.length < 2 || sharpeBasis.missingRateDays > 0 || averageRate === null ||
    dailyReturns.some(({ value }) => !Number.isFinite(value))) return { sharpe: null, sharpeBasis };
  const mean = dailyReturns.reduce((sum, { value }) => sum + value, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, { value }) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1);
  const dailyRiskFree = averageRate / 100 / 252;
  const sharpe = variance > 0 ? (mean - dailyRiskFree) / Math.sqrt(variance) * Math.sqrt(252) : null;
  return { sharpe: sharpe !== null && Number.isFinite(sharpe) ? sharpe : null, sharpeBasis };
}

export function missingRateWarning(basis?: SharpeBasis): string | null {
  return basis && basis.missingRateDays > 0
    ? `금리 자료가 없는 관측일 ${basis.missingRateDays}일의 임의 추정을 피하기 위해 Sharpe를 계산하지 않았습니다. ECOS 금리 동기화 상태를 확인하세요.`
    : null;
}
