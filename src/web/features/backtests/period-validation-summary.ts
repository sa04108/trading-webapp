import type { ValidationTrialDto } from "../../../shared/schemas/period-validation.js";

export function summarizeValidationOos(trials: readonly ValidationTrialDto[]) {
  const returns = trials.flatMap((trial) => {
    const value = trial.metrics?.totalReturnPct;
    return trial.role === "OOS" && trial.status === "COMPLETED" && typeof value === "number" && Number.isFinite(value) ? [value] : [];
  });
  const scale = returns.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const normalizedMean = returns.length && scale
    ? returns.reduce((sum, value) => sum + value / scale / returns.length, 0)
    : 0;
  const mean = returns.length ? scale * Math.max(-1, Math.min(1, normalizedMean)) : null;
  const standardDeviation = returns.length >= 2
    ? scale * Math.min(1, Math.sqrt(returns.reduce((sum, value) => sum + (scale ? (value / scale - normalizedMean) ** 2 : 0) / returns.length, 0)))
    : null;
  return {
    evaluated: returns.length,
    notEvaluated: trials.filter((trial) => trial.role === "OOS" && trial.status === "NOT_EVALUATED" && trial.skipReason === "NO_ELIGIBLE_CANDIDATE").length,
    mean,
    standardDeviation,
    profitable: returns.filter((value) => value > 0).length,
    worst: returns.length ? Math.min(...returns) : null,
  };
}
