import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { useBacktestLive, useStrategies } from "./api";
import { BacktestBreadcrumbs } from "./backtest-breadcrumbs";
import { StrategySeedExplanation } from "./experiment-help";
import { isTerminal, type SeedCloneBatchSummary } from "./types";

export function SeedExperimentsPage() {
  const { id = "" } = useParams();
  const source = useBacktestLive(id);
  const strategies = useStrategies();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [count, setCount] = useState("10");
  const query = useQuery({
    queryKey: ["backtest-clone-batches", "source", id],
    queryFn: ({ signal }) => api<{ batches: SeedCloneBatchSummary[] }>(`/backtest-clone-batches?${new URLSearchParams({ sourceJobIds: id })}`, { signal }),
    enabled: Boolean(id),
    refetchInterval: (q) => q.state.data?.batches.some((b) => b.status === "ACTIVE" || b.status === "CANCELLING") ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const create = useMutation({
    mutationFn: () => api<{ batch: { id: string } }>(`/backtests/${encodeURIComponent(id)}/clone-random-seeds`, { method: "POST", body: JSON.stringify({ count: Number(count) }) }),
    onSuccess: (data) => {
      void client.invalidateQueries({ queryKey: ["backtest-clone-batches"] });
      void client.invalidateQueries({ queryKey: ["backtest-experiments"] });
      void navigate(`/backtests/batches/${data.batch.id}`);
    },
    onError: (error) => toast.error(error.message),
  });
  const strategy = strategies.data?.strategies.find((s) => s.id === source.job?.strategyId);
  const canCreate = source.job && isTerminal(source.job.status) && !source.job.cloneBatchId && strategy && strategy.supportsRandomSeed !== false;
  const validCount = Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= 100;
  return <div className="space-y-4">
    <BacktestBreadcrumbs jobId={id} trail={[{ label: "난수 시드 실험" }]} />
    <h2 className="text-lg font-semibold">난수 시드 실험</h2>
    {source.isError ? <Alert variant="destructive"><AlertTitle>원본 백테스트를 불러올 수 없습니다</AlertTitle><AlertDescription>{source.error?.message}</AlertDescription></Alert> : source.job ? <>
      <p className="text-sm text-muted-foreground">{strategy?.name ?? source.job.strategyId} · {source.job.request.period.from} ~ {source.job.request.period.to}</p>
      <StrategySeedExplanation strategyId={source.job.strategyId} strategyVersion={source.run?.strategyVersion} />
      <Card><CardHeader><CardTitle className="text-sm">새 난수 시드 실험</CardTitle></CardHeader><CardContent>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (canCreate && validCount && !create.isPending) create.mutate(); }}>
          <div className="flex flex-wrap items-end gap-2"><div className="space-y-2"><Label htmlFor="seed-experiment-count">복제 개수 (1~100)</Label><Input id="seed-experiment-count" className="w-32" type="number" inputMode="numeric" min={1} max={100} step={1} value={count} onChange={(e) => setCount(e.target.value)} /></div>
            <Button type="submit" disabled={!canCreate || !validCount || create.isPending}>{create.isPending ? "생성 중…" : "난수 실험 시작"}</Button></div>
          {!canCreate ? <p className="text-sm text-muted-foreground">종료된 원본 백테스트와 난수 실험을 지원하는 전략이 필요합니다. 난수 실험의 개별 결과에서는 새 묶음을 만들 수 없습니다.</p> : null}
          {create.isError ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
        </form>
      </CardContent></Card>
    </> : <Skeleton className="h-40 w-full" />}
    <section aria-label="난수 실험 기록" className="space-y-3">
      <h3 className="font-medium">실험 기록{query.data ? ` · ${query.data.batches.length}개` : ""}</h3>
      {query.isError ? <Alert variant="destructive"><AlertTitle>실험 기록을 불러올 수 없습니다</AlertTitle><AlertDescription>{query.error.message}</AlertDescription></Alert> : query.isPending ? <Skeleton className="h-24 w-full" /> : query.data.batches.length === 0 ? <p className="text-sm text-muted-foreground">기록된 난수 시드 실험이 없습니다.</p> :
        query.data.batches.map((batch) => <Card key={batch.id}><CardContent className="space-y-2 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="font-medium">시드 {batch.totalCount}개</span><Badge variant="secondary">{({ ACTIVE: "진행 중", CANCELLING: "취소 중", COMPLETED: "완료", CANCELLED: "취소됨", FAILED: "실패" })[batch.status]}</Badge></div><Button variant="outline" size="sm" asChild><Link to={`/backtests/batches/${batch.id}`}>실험 보기</Link></Button></div>
          <p className="text-xs text-muted-foreground">{formatDateTime(batch.createdAtMs)} · 완료 {batch.completedCount}/{batch.totalCount} · 실패 {batch.failedCount}</p>
        </CardContent></Card>)}
    </section>
  </div>;
}
