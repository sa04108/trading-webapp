/**
 * 백테스트가 실제 소비한 봉 주기 (설계 2026-07-30-backtest-result-display-design.md §3).
 * request.timeframe 이 없는 잡(이 필드가 없던 시절)은 엔진이 데이터셋 timeframe 을
 * 썼으므로 같은 규칙으로 폴백한다. 데이터셋이 삭제됐으면 null.
 */
export function resolveJobTimeframe(
  job: { datasetId: string; request: { timeframe?: string } },
  datasets: readonly { id: string; timeframe: string }[] | undefined,
): string | null {
  if (job.request.timeframe) return job.request.timeframe;
  return datasets?.find((d) => d.id === job.datasetId)?.timeframe ?? null;
}
