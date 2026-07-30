/**
 * 백테스트 목록의 전략별 그룹화 (설계 2026-07-30-backtest-result-display-design.md §2).
 * API 정렬 순서에 기대지 않고 여기서 명시적으로 정렬한다 —
 * 그룹 내부는 최신순, 그룹끼리는 그룹 내 최신 잡 기준 내림차순.
 */
export function groupJobsByStrategy<T extends { strategyId: string; createdAtMs: number }>(
  jobs: readonly T[],
): Array<{ strategyId: string; jobs: T[] }> {
  const byStrategy = new Map<string, T[]>();
  for (const job of jobs) {
    const list = byStrategy.get(job.strategyId) ?? [];
    list.push(job);
    byStrategy.set(job.strategyId, list);
  }
  return [...byStrategy.entries()]
    .map(([strategyId, grouped]) => ({
      strategyId,
      jobs: [...grouped].sort((a, b) => b.createdAtMs - a.createdAtMs),
    }))
    .sort((a, b) => (b.jobs[0]?.createdAtMs ?? 0) - (a.jobs[0]?.createdAtMs ?? 0));
}
