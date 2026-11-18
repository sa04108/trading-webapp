import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { IntradayRun } from "@shared/schemas/intraday";
import { getIntradayStrategy } from "@shared/schemas/intraday-strategies";
import type { BacktestDetail, StrategySummary } from "./api";
import { experimentPaths, type ExperimentMode } from "./experiment-paths";

/** 실험 화면은 원본의 설정·전략 정보만 필요하며 완료된 원본을 계속 조회하지 않는다. */
export function useExperimentSource(id: string, mode: ExperimentMode) {
  const query = useQuery({
    queryKey: [mode === "intraday" ? "intraday-run" : "backtests", id],
    queryFn: ({ signal }) => api<IntradayRun | BacktestDetail>(experimentPaths(mode).apiResult(id), { signal }),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      const status = data && ("job" in data ? data.job.status : data.status);
      return status && ["QUEUED", "STARTING", "PREPARING", "RUNNING", "CANCELLING"].includes(status) ? 2_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const strategies = useQuery({
    queryKey: ["strategies"],
    queryFn: () => api<{ strategies: StrategySummary[] }>("/strategies"),
    enabled: mode === "daily",
    staleTime: 5 * 60_000,
  });
  let source;
  if (query.data && mode === "intraday") {
    const run = query.data as IntradayRun;
    source = {
      request: run.request, status: run.status,
      name: getIntradayStrategy(run.request.strategyId).name,
      strategyVersion: run.result?.strategyVersion,
    };
  } else if (query.data) {
    const { job, run } = query.data as BacktestDetail;
    const strategy = strategies.data?.strategies.find((item) => item.id === job.strategyId);
    source = {
      request: job.request, status: job.status, name: strategy?.name ?? job.strategyId,
      strategyVersion: run?.strategyVersion,
    };
  }
  return { source, isLoading: query.isLoading, error: query.error, isError: query.isError };
}
