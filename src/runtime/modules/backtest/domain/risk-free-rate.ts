import type { RiskFreeRateHistory } from "../../../../shared/schemas/risk-free-rate.js";

/** 해당 날짜까지의 변경점만 이진 탐색한다. 금리표 범위를 벗어나면 임의로 보간하지 않는다. */
export function annualRiskFreeRate(date: string, history: RiskFreeRateHistory): number | null {
  if (date < history.coveredFrom || date > history.coveredTo) return null;
  let low = 0;
  let high = history.changes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (history.changes[middle]!.date <= date) low = middle + 1;
    else high = middle;
  }
  return history.changes[low - 1]?.annualRatePct ?? null;
}
