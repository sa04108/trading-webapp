import { useQuery } from "@tanstack/react-query";
import type { BacktestHistoryExtras, BacktestLineage } from "@shared/schemas/backtest-experiments";
import { api } from "@/lib/api-client";
import { experimentPaths, type ExperimentMode } from "./experiment-paths";

export function useBacktestHistoryExtras(jobIds: readonly string[], interval: number | false = 5_000, mode: ExperimentMode = "daily") {
  const ids = [...new Set(jobIds)].sort();
  const paths = experimentPaths(mode);
  return useQuery({
    queryKey: [paths.summaryKey, "summaries", ids],
    queryFn: async ({ signal }) => {
      const summaries: BacktestHistoryExtras[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const page = await api<{ summaries: BacktestHistoryExtras[] }>(
          `${paths.summaries}?${new URLSearchParams({ jobIds: ids.slice(offset, offset + 100).join(",") })}`, { signal });
        summaries.push(...page.summaries);
      }
      return { summaries };
    },
    enabled: ids.length > 0,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
}

export function useBacktestLineage(jobId: string, mode: ExperimentMode = "daily") {
  const paths = experimentPaths(mode);
  return useQuery({
    queryKey: [paths.lineageKey, jobId],
    queryFn: ({ signal }) => api<BacktestLineage>(`${paths.apiResult(jobId)}/lineage`, { signal }),
    enabled: Boolean(jobId),
    staleTime: 60_000,
  });
}
