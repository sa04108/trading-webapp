import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import type { BacktestHistoryExtras } from "@shared/schemas/backtest-experiments";
import { experimentPaths, type ExperimentMode } from "./experiment-paths";

export function hasExperimentRecords(summary: BacktestHistoryExtras | undefined): boolean {
  return (summary?.seed.batchCount ?? 0) > 0 || (summary?.validation.experimentCount ?? 0) > 0;
}

export function ExperimentLinks({ jobId, summary, mode = "daily" }: { jobId: string; summary?: BacktestHistoryExtras; mode?: ExperimentMode }) {
  if (!hasExperimentRecords(summary)) return null;
  const paths = experimentPaths(mode);
  return <span className="relative z-10 inline-flex gap-1">
    {(summary?.seed.batchCount ?? 0) > 0 ? <Button asChild variant="outline" size="sm" className="h-5 px-2 text-xs"><Link to={paths.seeds(jobId)}>난수</Link></Button> : null}
    {(summary?.validation.experimentCount ?? 0) > 0 ? <Button asChild variant="outline" size="sm" className="h-5 px-2 text-xs"><Link to={paths.validations(jobId)}>검증</Link></Button> : null}
  </span>;
}
