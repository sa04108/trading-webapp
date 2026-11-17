import type { SharpeBasis } from "./risk-free-rate.js";

export type IntradayDayStatus = "COMPLETE" | "PARTIAL" | "MISSING" | "EXIT_FAILED" | "NOT_RUN";

export interface IntradayDayEvaluation {
  date: string;
  status: IntradayDayStatus;
  observedBars: number;
  missingMinutes: number;
  fillCount: number;
  closingQuantity: number | null;
  /** 불완전한 날짜도 관측 손익을 보존하되 정상 일별 통계에서는 제외한다. */
  pnl: number | null;
  returnPct: number | null;
  maxDrawdownPct: number | null;
}

export interface IntradayDailySummary {
  isComplete: boolean;
  expectedDays: number;
  evaluatedDays: number;
  partialDays: number;
  missingDays: number;
  notRunDays: number;
  exitFailedDays: number;
  activeDays: number;
  profitableDays: number;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  standardDeviationPct: number | null;
  profitableDayPct: number | null;
  worstReturnPct: number | null;
  worstDate: string | null;
  sharpe: number | null;
  maxConsecutiveLossDays: number;
  worstIntradayDrawdownPct: number | null;
  top3ProfitSharePct: number | null;
  earlyTermination: { date: string; remainingQuantity: number } | null;
}

export interface IntradayDailyReport {
  days: IntradayDayEvaluation[];
  summary: IntradayDailySummary;
  sharpeBasis: SharpeBasis;
}
