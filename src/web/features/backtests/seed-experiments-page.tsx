import { isRefreshRequired, useBacktestRefresh } from "./backtest-refresh-dialog";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, isUnavailableApiError } from "@/lib/api-client";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const navigate = useNavigate();
  const refresh = useBacktestRefresh(id);
  const [count, setCount] = useState("10");
  const query = useQuery({
    queryKey: ["backtest-clone-batches", "source", id],
    queryFn: ({ signal }) => api<{ batches: SeedCloneBatchSummary[] }>(`/backtest-clone-batches?${new URLSearchParams({ sourceJobIds: id })}`, { signal }),
    enabled: Boolean(id) && mode === "daily",
    refetchInterval: (q) => q.state.data?.batches.some((b) => b.status === "ACTIVE" || b.status === "CANCELLING") ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const create = useMutation({
    mutationFn: (requestedCount: number) => api<{ batch: { id: string } }>(`/backtests/${encodeURIComponent(id)}/clone-random-seeds`, { method: "POST", body: JSON.stringify({ count: requestedCount }) }),
    onSuccess: (data) => {
      void client.invalidateQueries({ queryKey: ["backtest-clone-batches"] });
      void client.invalidateQueries({ queryKey: ["backtest-experiments"] });
      void navigate(`/backtests/batches/${data.batch.id}`);
    },
    onError: (error, requestedCount) => {
      if (isRefreshRequired(error)) refresh.offer({ kind: "RANDOM_SEEDS", count: requestedCount }, error);
      else toast.error(error.message);
    },
  });
  const original = source.source;
  const canCreate = mode === "daily" && !source.isError && original && ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(original.status) && !original.cloneBatchId && original.supportsRandomSeed;
  const batches = mode === "intraday" ? [] : query.data?.batches;
  const validCount = Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= 100;
  return <div className="space-y-4">
    {refresh.modal}
    <BacktestBreadcrumbs jobId={id} mode={mode} trail={[{ label: "난수 시드 실험" }]} />
    <h2 className="text-lg font-semibold">난수 시드 실험</h2>
    {source.isError && original && !isUnavailableApiError(source.error) ? <Alert variant="destructive"><AlertDescription>원본을 새로 불러오지 못했습니다. <Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: [mode === "intraday" ? "intraday-run" : "backtests", id] })}>다시 시도</Button></AlertDescription></Alert> : null}
    {source.isError && (!original || isUnavailableApiError(source.error)) ? <Alert variant="destructive"><AlertTitle>원본 백테스트를 불러올 수 없습니다</AlertTitle><AlertDescription>{source.error?.message}</AlertDescription></Alert> : original ? <>
      <p className="text-sm text-muted-foreground">{original.name} · {original.request.period.from} ~ {original.request.period.to}</p>
      <StrategySeedExplanation strategyId={original.request.strategyId} strategyVersion={original.strategyVersion} mode={mode} />
      <Card><CardHeader><CardTitle className="text-sm">새 난수 시드 실험</CardTitle></CardHeader><CardContent>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (canCreate && validCount && !create.isPending) create.mutate(Number(count)); }}>
          <div className="flex flex-wrap items-end gap-2"><div className="space-y-2"><Label htmlFor="seed-experiment-count">복제 개수 (1~100)</Label><Input id="seed-experiment-count" className="w-32" type="number" inputMode="numeric" min={1} max={100} step={1} value={count} disabled={mode === "intraday"} onChange={(e) => setCount(e.target.value)} /></div>
            <Button type="submit" disabled={!canCreate || !validCount || create.isPending}>{create.isPending ? "생성 중…" : "난수 실험 시작"}</Button></div>
          {!canCreate ? <p className="text-sm text-muted-foreground">{mode === "intraday" ? "현재 분봉 전략은 난수를 사용하지 않아 시드 실험을 생성하지 않습니다." : "종료된 원본 백테스트와 난수 실험을 지원하는 전략이 필요합니다. 난수 실험의 개별 결과에서는 새 묶음을 만들 수 없습니다."}</p> : null}
          {create.isError && !isRefreshRequired(create.error) ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
        </form>
      </CardContent></Card>
    </> : <Skeleton className="h-40 w-full" />}
    <section aria-label="난수 실험 기록" className="space-y-3">
      <h3 className="font-medium">실험 기록{batches ? ` · ${batches.length}개` : ""}</h3>
      {mode === "daily" && query.isError && batches && !isUnavailableApiError(query.error) ? <Alert variant="destructive"><AlertDescription>실험 기록을 새로 불러오지 못했습니다. <Button variant="outline" onClick={() => void query.refetch()}>다시 시도</Button></AlertDescription></Alert> : null}
      {mode === "daily" && query.isError && (!batches || isUnavailableApiError(query.error)) ? <Alert variant="destructive"><AlertTitle>실험 기록을 불러올 수 없습니다</AlertTitle><AlertDescription>{query.error.message}</AlertDescription></Alert> : !batches ? <Skeleton className="h-24 w-full" /> : batches.length === 0 ? <p className="text-sm text-muted-foreground">기록된 난수 시드 실험이 없습니다.</p> :
        batches.map((batch) => <Card key={batch.id}><CardContent className="space-y-2 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="font-medium">시드 {batch.totalCount}개</span>{batch.status !== "COMPLETED" ? <Badge variant="secondary">{({ ACTIVE: "진행 중", CANCELLING: "취소 중", CANCELLED: "취소됨", FAILED: "실패" })[batch.status]}</Badge> : null}</div><Button variant="outline" size="sm" asChild><Link to={`/backtests/batches/${batch.id}`}>실험 보기</Link></Button></div>
          <p className="text-xs text-muted-foreground">{formatDateTime(batch.createdAtMs)} · 완료 {batch.completedCount}/{batch.totalCount} · 실패 {batch.failedCount}</p>
        </CardContent></Card>)}
    </section>
    <Button asChild variant="outline"><Link to={paths.result(id)}>원본 결과</Link></Button>
  </div>;
}
