import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isUnavailableApiError } from "@/lib/api-client";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { useExperimentSource } from "./use-experiment-source";
import { experimentPaths, type ExperimentMode } from "./experiment-paths";
import { BacktestBreadcrumbs } from "./backtest-breadcrumbs";
import { StrategySeedExplanation } from "./experiment-help";
import type { SeedCloneBatchSummary } from "./types";

export function SeedExperimentsPage({ mode = "daily" }: { mode?: ExperimentMode }) {
  const { id = "" } = useParams();
  const source = useExperimentSource(id, mode);
  const paths = experimentPaths(mode);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["backtest-clone-batches", "source", id],
    queryFn: ({ signal }) => api<{ batches: SeedCloneBatchSummary[] }>(`/backtest-clone-batches?${new URLSearchParams({ sourceJobIds: id })}`, { signal }),
    enabled: Boolean(id) && mode === "daily",
    refetchInterval: (q) => q.state.data?.batches.some((b) => b.status === "ACTIVE" || b.status === "CANCELLING") ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const original = source.source;
  const batches = mode === "intraday" ? [] : query.data?.batches;
  return <div className="space-y-4">
    <BacktestBreadcrumbs jobId={id} mode={mode} trail={[{ label: "이전 설정 탐색 실험" }]} />
    <h2 className="text-lg font-semibold">이전 설정 탐색 실험</h2>
    {source.isError && original && !isUnavailableApiError(source.error) ? <Alert variant="destructive"><AlertDescription>원본을 새로 불러오지 못했습니다. <Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: [mode === "intraday" ? "intraday-run" : "backtests", id] })}>다시 시도</Button></AlertDescription></Alert> : null}
    {source.isError && (!original || isUnavailableApiError(source.error)) ? <Alert variant="destructive"><AlertTitle>원본 백테스트를 불러올 수 없습니다</AlertTitle><AlertDescription>{source.error?.message}</AlertDescription></Alert> : original ? <>
      <p className="text-sm text-muted-foreground">{original.name} · {original.request.period.from} ~ {original.request.period.to}</p>
      <StrategySeedExplanation strategyId={original.request.strategyId} strategyVersion={original.strategyVersion} mode={mode} />
      <p className="text-sm text-muted-foreground">새 실험은 설정 탐색에서 시작할 수 있습니다.</p>
      <Button asChild variant="outline"><Link to={paths.search(id)}>설정 탐색 실험 열기</Link></Button>
    </> : <Skeleton className="h-40 w-full" />}
    <section aria-label="이전 실험 기록" className="space-y-3">
      <h3 className="font-medium">실험 기록{batches ? ` · ${batches.length}개` : ""}</h3>
      {mode === "daily" && query.isError && batches && !isUnavailableApiError(query.error) ? <Alert variant="destructive"><AlertDescription>실험 기록을 새로 불러오지 못했습니다. <Button variant="outline" onClick={() => void query.refetch()}>다시 시도</Button></AlertDescription></Alert> : null}
      {mode === "daily" && query.isError && (!batches || isUnavailableApiError(query.error)) ? <Alert variant="destructive"><AlertTitle>실험 기록을 불러올 수 없습니다</AlertTitle><AlertDescription>{query.error.message}</AlertDescription></Alert> : !batches ? <Skeleton className="h-24 w-full" /> : batches.length === 0 ? <p className="text-sm text-muted-foreground">기록된 이전 설정 탐색 실험이 없습니다.</p> :
        batches.map((batch) => <Card key={batch.id}><CardContent className="space-y-2 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="font-medium">시드 {batch.totalCount}개</span>{batch.status !== "COMPLETED" ? <Badge variant="secondary">{({ ACTIVE: "진행 중", CANCELLING: "취소 중", CANCELLED: "취소됨", FAILED: "실패" })[batch.status]}</Badge> : null}</div><Button variant="outline" size="sm" asChild><Link to={`/backtests/batches/${batch.id}`}>실험 보기</Link></Button></div>
          <p className="text-xs text-muted-foreground">{formatDateTime(batch.createdAtMs)} · 완료 {batch.completedCount}/{batch.totalCount} · 실패 {batch.failedCount}</p>
        </CardContent></Card>)}
    </section>
    <Button asChild variant="outline"><Link to={paths.result(id)}>원본 결과</Link></Button>
  </div>;
}
