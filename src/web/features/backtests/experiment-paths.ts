export type ExperimentMode = "daily" | "intraday";

/** 일봉과 분봉은 같은 실험 화면을 사용하고 실행 API와 결과 경로만 구분한다. */
export function experimentPaths(mode: ExperimentMode = "daily") {
  const intraday = mode === "intraday";
  const base = intraday ? "/backtests/intraday" : "/backtests";
  const apiBase = intraday ? "/intraday/runs" : "/backtests";
  return {
    result: (id: string) => `${base}/${encodeURIComponent(id)}`,
    search: (id: string) => `${base}/${encodeURIComponent(id)}/search`,
    validations: (id: string) => `${base}/${encodeURIComponent(id)}/validations`,
    validation: (id: string) => `${base}/validations/${encodeURIComponent(id)}`,
    apiResult: (id: string) => `${apiBase}/${encodeURIComponent(id)}`,
    apiValidations: (id: string) => `${apiBase}/${encodeURIComponent(id)}/validations`,
    apiValidation: (id: string) => `${intraday ? "/intraday/validations" : "/backtest-validations"}/${encodeURIComponent(id)}`,
    summaries: intraday ? "/intraday/experiments/summary" : "/backtests/history-extras",
    summaryKey: intraday ? "intraday-experiments" : "backtest-experiments",
    validationsKey: intraday ? "intraday-validations" : "period-validations",
    validationKey: intraday ? "intraday-validation" : "period-validation",
    lineageKey: intraday ? "intraday-lineage" : "backtest-lineage",
  };
}
