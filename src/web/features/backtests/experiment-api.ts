import { useQuery } from "@tanstack/react-query";
import type { BacktestHistoryExtras, BacktestLineage } from "@shared/schemas/backtest-experiments";
import { api } from "@/lib/api-client";

export function useBacktestHistoryExtras(jobIds: readonly string[], interval: number | false = 5_000) {
  const ids = [...new Set(jobIds)].sort();
  return useQuery({
    queryKey: ["backtest-experiments", "summaries", ids],
    queryFn: async ({ signal }) => {
      const summaries: BacktestHistoryExtras[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const page = await api<{ summaries: BacktestHistoryExtras[] }>(
          `/backtests/history-extras?${new URLSearchParams({ jobIds: ids.slice(offset, offset + 100).join(",") })}`, { signal });
        summaries.push(...page.summaries);
      }
      return { summaries };
    },
    enabled: ids.length > 0,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
}

export function useBacktestLineage(jobId: string) {
  return useQuery({
    queryKey: ["backtest-lineage", jobId],
    queryFn: ({ signal }) => api<BacktestLineage>(`/backtests/${encodeURIComponent(jobId)}/lineage`, { signal }),
    enabled: Boolean(jobId),
    staleTime: 60_000,
  });
}
