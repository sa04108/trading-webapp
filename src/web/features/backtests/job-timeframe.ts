/**
 * 백테스트가 실제 소비한 봉 주기 (설계 2026-07-30-backtest-result-display-design.md §3).
 * request.timeframe 이 없는 잡(이 필드가 없던 시절)은 엔진이 데이터셋 defaultTimeframe 을
 * 서버의 legacyConsumeDefault 규칙(src/server/modules/market-data/domain/dataset-slice.ts)
 * 대로 소비했으므로 같은 규칙으로 폴백한다 — '1m' → '1h', '1d' → '1d'.
 * 데이터셋이 삭제됐으면 null.
 */
export function resolveJobTimeframe(
  job: { datasetId: string; request: { timeframe?: string } },
  datasets: readonly { id: string; defaultTimeframe: string }[] | undefined,
): string | null {
  if (job.request.timeframe) return job.request.timeframe;
  const dataset = datasets?.find((d) => d.id === job.datasetId);
  if (!dataset) return null;
  return dataset.defaultTimeframe === '1m' ? '1h' : '1d';
}
