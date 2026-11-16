import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { api, postJson } from "@/lib/api-client";
import { formatSignedPct } from "@/lib/format";
import { BENCHMARK_IDS, BENCHMARK_NAMES, type BenchmarkComparisons, type BenchmarkId } from "../../../shared/schemas/benchmark.js";
import { BenchmarkComparisonChart } from "./result-charts";
import type { SeriesPoint } from "./types";

export function ResultBenchmarkComparison({ jobId, period, strategy, initialCash }: {
  jobId: string;
  period: { from: string; to: string };
  strategy: SeriesPoint[];
  initialCash: number;
}) {
  const client = useQueryClient();
  const [pendingSelection, setPendingSelection] = useState<BenchmarkId[] | null>(null);
  const key = ["backtests", jobId, "benchmarks"] as const;
  const path = `/backtests/${encodeURIComponent(jobId)}/benchmarks`;
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<BenchmarkComparisons>(path),
    retry: false,
    refetchInterval: (current) => current.state.data?.backfill.state === "RUNNING" ? 1_000 : false,
  });
  const selection = useMutation({
    mutationFn: (benchmarkIds: BenchmarkId[]) => api<{ benchmarkIds: BenchmarkId[] }>(path, { method: "PATCH", body: JSON.stringify({ benchmarkIds }) }),
    onMutate: async (benchmarkIds) => {
      const cancellation = client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<BenchmarkComparisons>(key);
      client.setQueryData<BenchmarkComparisons>(key, (current) => current && {
        ...current,
        benchmarkIds,
        comparisons: current.comparisons.filter((item) => benchmarkIds.includes(item.benchmarkId)),
      });
      await cancellation;
      return { previous };
    },
    onError: (_error, _benchmarkIds, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSuccess: ({ benchmarkIds }) => {
      client.setQueryData<BenchmarkComparisons>(key, (current) => current && {
        ...current,
        benchmarkIds,
        comparisons: current.comparisons.filter((item) => benchmarkIds.includes(item.benchmarkId)),
      });
    },
    onSettled: async () => {
      try { await client.invalidateQueries({ queryKey: key }); }
      finally { setPendingSelection(null); }
    },
  });
  const backfill = useMutation({
    mutationFn: (benchmarkId: BenchmarkId) => postJson("/benchmarks/backfill", { benchmarkId, from: period.from, to: period.to }),
    retry: false,
    onSettled: async () => { await client.invalidateQueries({ queryKey: key }); },
  });
  const selected = pendingSelection ?? query.data?.benchmarkIds ?? [];
  const saving = pendingSelection !== null || selection.isPending;
  const running = query.data?.backfill.state === "RUNNING";
  const available = query.data?.comparisons.filter((item) => item.available) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">벤치마크 비교</CardTitle>
        <CardDescription>비교할 지수를 선택하면 이 결과에 저장됩니다. 지수는 기간 첫 종가를 0%로 맞추며 배당 재투자·환율 환산은 포함하지 않습니다.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending ? <p className="text-sm text-muted-foreground">비교 설정을 불러오는 중…</p> : null}
        {query.error && <Alert variant="destructive" role="alert"><AlertDescription>비교 설정을 불러오지 못했습니다: {query.error instanceof Error ? query.error.message : "요청에 실패했습니다."} <Button variant="outline" size="sm" onClick={() => void query.refetch()}>다시 시도</Button></AlertDescription></Alert>}
        {query.data && <>
          <fieldset disabled={saving} className="flex flex-wrap gap-x-4 gap-y-2">
            <legend className="mb-2 text-sm font-medium">비교 지수</legend>
            {BENCHMARK_IDS.map((id) => <label key={id} className="flex items-center gap-2 text-sm"><Checkbox checked={selected.includes(id)} disabled={saving} onCheckedChange={(checked) => {
              const next = checked === true ? [...selected, id] : selected.filter((value) => value !== id);
              // 체크 표시는 클릭과 함께 바꾸고 저장·재조회가 끝날 때까지 유지한다.
              setPendingSelection(next);
              backfill.reset();
              selection.mutate(next);
            }} />{BENCHMARK_NAMES[id]}</label>)}
          </fieldset>
          {selection.error && <Alert variant="destructive" role="alert"><AlertDescription>선택을 저장하지 못했습니다: {selection.error instanceof Error ? selection.error.message : "요청에 실패했습니다."}</AlertDescription></Alert>}
          {running && <p className="text-sm text-muted-foreground" role="status">{query.data.backfill.benchmarkId ? BENCHMARK_NAMES[query.data.backfill.benchmarkId] : "벤치마크"} 데이터를 수집하는 중입니다{query.data.backfill.cursorDate ? ` · ${query.data.backfill.cursorDate}` : ""}.</p>}
          {selected.length === 0 && <p className="text-sm text-muted-foreground">선택한 비교 지수가 없습니다.</p>}
          {available.length > 0 && strategy.length > 0 && initialCash > 0 && <BenchmarkComparisonChart strategy={strategy} comparisons={available} initialCash={initialCash} />}
          {query.data.comparisons.map((item) => <section key={item.benchmarkId} aria-label={`${item.name} 비교`} className="space-y-2 rounded border p-3 text-sm">
            <h3 className="font-medium">{item.name}</h3>
            {item.available ? <p>수익률 {formatSignedPct(item.totalReturnPct)} · 최대 낙폭 {formatSignedPct(item.maxDrawdownPct)} · 초과 수익률 {formatSignedPct(item.excessReturnPct).replace(/%$/, "%p")}</p> : <>
              <p className="text-muted-foreground">{item.unavailableReason ?? "비교 데이터가 부족합니다."}</p>
              {query.data.backfill.benchmarkId === item.benchmarkId && query.data.backfill.from === period.from && query.data.backfill.to === period.to && query.data.backfill.state === "FAILED" && <p role="alert" className="text-destructive">수집 실패: {query.data.backfill.error ?? "다시 시도해 주세요."}</p>}
              <Button variant="outline" size="sm" disabled={running || backfill.isPending} onClick={() => { backfill.reset(); backfill.mutate(item.benchmarkId); }}>비교 데이터 수집</Button>
              {backfill.error && backfill.variables === item.benchmarkId && <p role="alert" className="text-destructive">수집을 시작하지 못했습니다: {backfill.error instanceof Error ? backfill.error.message : "요청에 실패했습니다."}</p>}
            </>}
          </section>)}
        </>}
      </CardContent>
    </Card>
  );
}
