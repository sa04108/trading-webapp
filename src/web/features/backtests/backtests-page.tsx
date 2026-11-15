import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Dices, Plus } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { useStrategies } from "./api";
import {
  HistoryPager,
  HistoryToolbar,
  historyPeriod,
  useHistoryControls,
} from "./history-controls";
import type { HistoryGroup } from "../../../shared/schemas/backtest-history";
import { BacktestHeader } from "./backtest-header";
import {
  formatDateTime,
  formatSignedPct,
  pnlClass,
  timeframeLabel,
} from "@/lib/format";
import { resolveJobTimeframe } from "./job-timeframe";
import { StatusBadge } from "./status-badge";
import {
  ExecutionProgressSummary,
  executionProgressPercent,
} from "./execution-progress-display";
import { formatUniverseRuleSummary } from "./universe-summary";
import {
  isTerminal,
  type JobSummary,
  type SeedCloneBatchSummary,
} from "./types";

export function deletableBacktestIds(jobs: readonly JobSummary[]): string[] {
  return jobs.filter((job) => isTerminal(job.status)).map((job) => job.id);
}

export function groupSeedBatchesBySource(
  batches: readonly SeedCloneBatchSummary[],
): ReadonlyMap<string, readonly SeedCloneBatchSummary[]> {
  const grouped = new Map<string, SeedCloneBatchSummary[]>();
  for (const batch of batches) {
    const sourceBatches = grouped.get(batch.sourceJobId) ?? [];
    sourceBatches.push(batch);
    grouped.set(batch.sourceJobId, sourceBatches);
  }
  return grouped;
}

export function hasActiveSeedBatch(
  batches: readonly SeedCloneBatchSummary[],
): boolean {
  return batches.some(
    (batch) => batch.status === "ACTIVE" || batch.status === "CANCELLING",
  );
}

/** 기본 50개 목록 밖 원본도 배치 API가 돌려준 요약으로 복원한다. */
export function mergeBacktestSources(
  listedJobs: readonly JobSummary[],
  batchSourceJobs: readonly JobSummary[],
): JobSummary[] {
  const merged = new Map(listedJobs.map((job) => [job.id, job]));
  for (const source of batchSourceJobs) {
    if (!merged.has(source.id)) merged.set(source.id, source);
  }
  return [...merged.values()];
}

export function toggleAllBacktests(
  selected: ReadonlySet<string>,
  deletableIds: readonly string[],
): ReadonlySet<string> {
  const allSelected =
    deletableIds.length > 0 && deletableIds.every((id) => selected.has(id));
  return allSelected ? new Set() : new Set(deletableIds);
}

export function BacktestJobCard({
  job,
  timeframe,
  editing,
  selected,
  deletable,
  onToggle,
}: {
  job: JobSummary;
  timeframe: string | null;
  editing: boolean;
  selected: boolean;
  deletable?: boolean;
  onToggle: () => void;
}) {
  const running = !isTerminal(job.status);
  const barsProgress =
    job.progressBars !== null && job.totalBars !== null && job.totalBars > 0
      ? Math.round((job.progressBars / job.totalBars) * 100)
      : null;
  const activity = job.progress;
  const progress = activity ? executionProgressPercent(activity) : barsProgress;

  const card = (
    <Card className="transition-colors hover:bg-muted/40">
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={job.status} />
          <span className="ml-auto text-xs text-muted-foreground">
            {formatDateTime(job.createdAtMs)}
          </span>
        </div>
        <p className="whitespace-nowrap text-sm font-medium">
          {historyPeriod(job.request.period.from, job.request.period.to)}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatUniverseRuleSummary(job.request.universeRule)}
          {timeframe ? ` · ${timeframeLabel(timeframe)}` : ""}
        </p>
        {running && (progress !== null || activity) ? (
          <div className="space-y-1">
            {progress !== null ? (
              <>
                <Progress value={progress} aria-label={`진행률 ${progress}%`} />
                <p className="text-xs text-muted-foreground">{progress}%</p>
              </>
            ) : null}
            {activity ? (
              <ExecutionProgressSummary progress={activity} compact />
            ) : null}
          </div>
        ) : null}
        {job.status === "COMPLETED" && job.metrics ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">수익률</p>
                <p
                  className={`text-xl font-semibold tabular-nums ${pnlClass(job.metrics.totalReturnPct)}`}
                >
                  {formatSignedPct(job.metrics.totalReturnPct)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">CAGR</p>
                <p
                  className={`text-xl font-semibold tabular-nums ${pnlClass(job.metrics.cagrPct)}`}
                >
                  {formatSignedPct(job.metrics.cagrPct)}
                </p>
              </div>
            </div>
            <div className="flex justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
              <span>MDD {formatSignedPct(job.metrics.maxDrawdownPct)}</span>
              <span>매도 체결 {job.metrics.tradeCount}건</span>
            </div>
          </div>
        ) : null}
        {job.error ? (
          <p className="break-words text-xs text-destructive">{job.error}</p>
        ) : null}
      </CardContent>
    </Card>
  );

  if (!editing) {
    return (
      <Link to={`/backtests/${job.id}`} className="block">
        {card}
      </Link>
    );
  }

  if (!(deletable ?? isTerminal(job.status))) {
    return (
      <div className="flex items-start gap-3">
        <span className="mt-5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">{card}</div>
      </div>
    );
  }

  const checkboxId = `backtest-${job.id}`;
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id={checkboxId}
        checked={selected}
        onCheckedChange={onToggle}
        aria-label={`${formatDateTime(job.createdAtMs)} 백테스트 선택`}
        className="mt-5"
      />
      <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
        {card}
      </label>
    </div>
  );
}

export function SeedCloneBatchCard({
  batch,
  editing = false,
  removing = false,
  onRemove,
}: {
  batch: SeedCloneBatchSummary;
  editing?: boolean;
  removing?: boolean;
  onRemove?: () => void;
}) {
  const terminal =
    batch.completedCount +
    batch.failedCount +
    batch.cancelledCount +
    batch.interruptedCount +
    batch.deletedCount;
  const progress = Math.round((terminal / batch.totalCount) * 100);
  const card = (
    <Card className="transition-colors hover:bg-muted/40">
      <CardContent className="space-y-2 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Dices className="size-4" />
          <span className="font-medium">난수 시드 {batch.totalCount}개</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {formatDateTime(batch.createdAtMs)}
          </span>
        </div>
        <Progress
          value={progress}
          aria-label={`난수 시드 실험 진행률 ${progress}%`}
        />
        <p className="text-xs text-muted-foreground">
          완료 {batch.completedCount} · 실행 {batch.runningCount} · 실행 대기{" "}
          {batch.queuedCount}
          {" · "}묶음 대기 {batch.pendingCount} · 실패 {batch.failedCount}
        </p>
      </CardContent>
    </Card>
  );
  if (!editing) {
    return (
      <Link to={`/backtests/batches/${batch.id}`} className="block">
        {card}
      </Link>
    );
  }
  const active = batch.status === "ACTIVE" || batch.status === "CANCELLING";
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">{card}</div>
      <Button
        variant="destructive"
        size="sm"
        disabled={active || removing}
        title={
          active
            ? "실행 중인 실험은 취소 완료 후 삭제할 수 있습니다"
            : undefined
        }
        onClick={onRemove}
      >
        실험 삭제
      </Button>
    </div>
  );
}

export function BacktestsPage() {
  const client = useQueryClient();
  const controls = useHistoryControls();
  const strategies = useStrategies();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const clear = () => setSelected(new Set());
  const groups = useQuery({
    queryKey: ["backtests", "groups"],
    queryFn: () => api<{ groups: HistoryGroup[] }>("/backtests/groups"),
    refetchInterval: 5_000,
  });
  const limit = controls.view === "cards" ? 6 : 10;
  const pages = useQueries({
    queries: (groups.data?.groups ?? []).map((group) => {
      const params = new URLSearchParams({
        strategyId: group.strategyId,
        sort: controls.sort,
        dir: controls.dir,
        limit: String(limit),
        offset: String((controls.page(group.strategyId) - 1) * limit),
      });
      return {
        queryKey: ["backtests", "history", params.toString()],
        queryFn: () =>
          api<{ jobs: JobSummary[]; total: number }>(`/backtests?${params}`),
        enabled: !controls.collapsed(group.strategyId),
        refetchInterval: 5_000,
      };
    }),
  });
  const visibleJobs = pages.flatMap((query, index) =>
    controls.collapsed(groups.data?.groups[index]?.strategyId ?? "")
      ? []
      : (query.data?.jobs ?? []),
  );
  const sourceIds = visibleJobs.map((job) => job.id).sort();
  const batchQuery = useQuery({
    queryKey: ["backtest-clone-batches", "sources", sourceIds],
    queryFn: () =>
      api<{ batches: SeedCloneBatchSummary[]; sourceJobs: JobSummary[] }>(
        `/backtest-clone-batches?${new URLSearchParams({ sourceJobIds: sourceIds.join(",") })}`,
      ),
    enabled: sourceIds.length > 0,
    refetchInterval: 5_000,
  });
  const batchesBySource = groupSeedBatchesBySource(
    batchQuery.data?.batches ?? [],
  );
  const batchReady =
    sourceIds.length === 0 ||
    (batchQuery.isSuccess && !batchQuery.isFetching && !batchQuery.isError);
  const deletableIds = batchReady
    ? deletableBacktestIds(visibleJobs).filter(
        (id) => !hasActiveSeedBatch(batchesBySource.get(id) ?? []),
      )
    : [];
  const selectedIds = deletableIds.filter((id) => selected.has(id));
  const corrections = (groups.data?.groups ?? []).flatMap((group, index) => {
    const query = pages[index];
    if (
      !query?.data ||
      query.isFetching ||
      controls.collapsed(group.strategyId)
    )
      return [];
    const last = Math.max(1, Math.ceil(query.data.total / limit));
    return controls.page(group.strategyId) > last
      ? [{ id: group.strategyId, page: last }]
      : [];
  });
  const correctionKey = JSON.stringify(corrections);
  const { correctPages } = controls;
  useEffect(() => {
    const pending = JSON.parse(correctionKey) as Array<{
      id: string;
      page: number;
    }>;
    if (!pending.length) return;
    correctPages(pending);
    setSelected((previous) => (previous.size ? new Set() : previous));
  }, [correctionKey, correctPages]);
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["backtests"] });
    void client.invalidateQueries({ queryKey: ["backtest-clone-batches"] });
  };
  const remove = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(
        ids.map((id) => api(`/backtests/${id}`, { method: "DELETE" })),
      ),
    onSuccess: (_result, ids) => {
      toast.success(`백테스트 ${ids.length}개를 삭제했습니다`);
      clear();
      setEditing(false);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: invalidate,
  });
  const removeBatch = useMutation({
    mutationFn: (id: string) =>
      api(`/backtest-clone-batches/${id}`, { method: "DELETE" }),
    onSuccess: () => toast.success("난수 시드 실험을 삭제했습니다"),
    onError: (error: Error) => toast.error(error.message),
    onSettled: invalidate,
  });
  const toggleOne = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="space-y-4">
      <BacktestHeader
        mode="daily"
        actions={
          <>
            {visibleJobs.length > 0 || editing ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditing(!editing);
                  clear();
                }}
              >
                {editing ? "완료" : "편집"}
              </Button>
            ) : null}
            <Button asChild className="h-11 w-11 px-0 sm:w-auto sm:px-4">
              <Link to="/backtests/new" aria-label="새 백테스트">
                <Plus data-icon="inline-start" />
                <span className="hidden sm:inline">새 백테스트</span>
              </Link>
            </Button>
          </>
        }
      />
      <HistoryToolbar controls={controls} onChange={clear} />
      {editing ? (
        <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap pb-1">
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Checkbox
              checked={
                deletableIds.length > 0 &&
                selectedIds.length === deletableIds.length
              }
              onCheckedChange={() =>
                setSelected(toggleAllBacktests(selected, deletableIds))
              }
              aria-label="현재 페이지 선택"
            />
            현재 페이지 선택
          </label>
          <Button
            variant="destructive"
            size="sm"
            disabled={!selectedIds.length || remove.isPending}
            onClick={() => remove.mutate(selectedIds)}
          >
            현재 페이지 선택 삭제 ({selectedIds.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!deletableIds.length || remove.isPending}
            onClick={() => remove.mutate(deletableIds)}
          >
            현재 페이지 전체 삭제
          </Button>
        </div>
      ) : null}
      {batchQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          시드 실험을 불러오지 못해 원본 삭제가 비활성화되었습니다.
        </p>
      ) : null}
      {groups.isError ? (
        <p role="alert" className="text-destructive">
          이력 그룹을 불러오지 못했습니다.
        </p>
      ) : null}
      {groups.isLoading ? <Skeleton className="h-24 w-full" /> : null}
      {groups.data?.groups.length === 0 ? (
        <p>백테스트가 없습니다. 새 백테스트를 실행해 보세요.</p>
      ) : null}
      {(groups.data?.groups ?? []).map((group, index) => {
        const query = pages[index];
        const strategy = strategies.data?.strategies.find(
          (s) => s.id === group.strategyId,
        );
        const name = strategy?.name ?? group.strategyId;
        const batchCards = (job: JobSummary) =>
          (batchesBySource.get(job.id) ?? []).map((batch) => (
            <SeedCloneBatchCard
              key={batch.id}
              batch={batch}
              editing={editing}
              removing={
                removeBatch.isPending && removeBatch.variables === batch.id
              }
              onRemove={() => removeBatch.mutate(batch.id)}
            />
          ));
        return (
          <section key={group.strategyId} className="space-y-3">
            <button
              type="button"
              className="flex w-full items-center gap-2 border-b py-2 text-left font-semibold"
              aria-expanded={!controls.collapsed(group.strategyId)}
              onClick={() => {
                controls.toggle(group.strategyId);
                clear();
              }}
            >
              {name}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {group.total}건
              </span>
              <span className="ml-auto">
                {controls.collapsed(group.strategyId) ? "▸" : "▾"}
              </span>
            </button>
            {!controls.collapsed(group.strategyId) ? (
              <>
                {strategy?.description ? (
                  <InfoHint label={`${name} 전략 설명`}>
                    <p>{strategy.description}</p>
                  </InfoHint>
                ) : null}
                {query?.isError ? (
                  <p role="alert" className="text-destructive">
                    이력을 불러오지 못했습니다.
                  </p>
                ) : null}
                {query?.isLoading ? <Skeleton className="h-24 w-full" /> : null}
                {controls.view === "cards" ? (
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
                    {query?.data?.jobs.map((job) => (
                      <div
                        key={job.id}
                        className="min-w-0 max-w-[360px] space-y-2"
                      >
                        <BacktestJobCard
                          job={job}
                          timeframe={resolveJobTimeframe(job)}
                          editing={editing}
                          selected={selected.has(job.id)}
                          deletable={deletableIds.includes(job.id)}
                          onToggle={() => toggleOne(job.id)}
                        />
                        <div className="space-y-2 border-l-2 pl-4">
                          {batchCards(job)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <table className="w-full table-fixed text-xs">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="w-[52%] py-2 text-left sm:w-[38%]">
                          기간
                        </th>
                        <th className="text-right">수익률</th>
                        <th className="text-right">CAGR</th>
                        <th className="hidden text-right sm:table-cell">MDD</th>
                        <th className="hidden text-right sm:table-cell">
                          실행일
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {query?.data?.jobs.map((job) => (
                        <Fragment key={job.id}>
                          <tr className="border-t">
                            <td className="py-3 align-top">
                              {editing && deletableIds.includes(job.id) ? (
                                <Checkbox
                                  className="mr-1"
                                  checked={selected.has(job.id)}
                                  onCheckedChange={() => toggleOne(job.id)}
                                  aria-label={`${formatDateTime(job.createdAtMs)} 백테스트 선택`}
                                />
                              ) : null}
                              {editing ? (
                                <span className="whitespace-nowrap text-[11px] sm:text-xs">
                                  {historyPeriod(
                                    job.request.period.from,
                                    job.request.period.to,
                                  )}
                                </span>
                              ) : (
                                <Link
                                  className="whitespace-nowrap text-[11px] underline sm:text-xs"
                                  to={`/backtests/${job.id}`}
                                >
                                  {historyPeriod(
                                    job.request.period.from,
                                    job.request.period.to,
                                  )}
                                </Link>
                              )}
                              <div className="text-muted-foreground">
                                <StatusBadge status={job.status} />{" "}
                                <span className="sm:hidden">
                                  {formatDateTime(job.createdAtMs)}
                                </span>
                              </div>
                              {job.error ? (
                                <p className="break-words text-destructive">
                                  {job.error}
                                </p>
                              ) : null}
                              {job.progress && !isTerminal(job.status) ? (
                                <ExecutionProgressSummary
                                  progress={job.progress}
                                  compact
                                />
                              ) : null}
                              {!job.progress &&
                              !isTerminal(job.status) &&
                              job.progressBars !== null &&
                              job.totalBars !== null &&
                              job.totalBars > 0 ? (
                                <p className="text-muted-foreground">
                                  진행률{" "}
                                  {Math.round(
                                    (job.progressBars / job.totalBars) * 100,
                                  )}
                                  %
                                </p>
                              ) : null}
                            </td>
                            <td
                              className={`text-right ${pnlClass(job.metrics?.totalReturnPct ?? null)}`}
                            >
                              {formatSignedPct(
                                job.metrics?.totalReturnPct ?? null,
                              )}
                            </td>
                            <td
                              className={`text-right ${pnlClass(job.metrics?.cagrPct ?? null)}`}
                            >
                              {formatSignedPct(job.metrics?.cagrPct ?? null)}
                            </td>
                            <td className="hidden text-right sm:table-cell">
                              {formatSignedPct(
                                job.metrics?.maxDrawdownPct ?? null,
                              )}
                            </td>
                            <td className="hidden text-right sm:table-cell">
                              {formatDateTime(job.createdAtMs)}
                            </td>
                          </tr>
                          {(batchesBySource.get(job.id) ?? []).length ? (
                            <tr>
                              <td colSpan={3}>
                                <div className="space-y-2 py-2">
                                  {batchCards(job)}
                                </div>
                              </td>
                              <td
                                colSpan={2}
                                className="hidden sm:table-cell"
                              />
                            </tr>
                          ) : null}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
                {query?.data ? (
                  <HistoryPager
                    page={controls.page(group.strategyId)}
                    total={query.data.total}
                    limit={limit}
                    onPage={(page) => {
                      controls.setPage(group.strategyId, page);
                      clear();
                    }}
                  />
                ) : null}
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
