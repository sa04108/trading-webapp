import { HistoryResultCard, HistoryResultDetails } from "./history-result-card";
import { BacktestDeleteDialog } from "./backtest-delete-dialog";
import { useHistoryQueries } from "./use-history-queries";
import { useHistoryEditing } from "./history-editing";
import {
  useQuery,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import { HistoryLayout, HistoryMetricCells, HistoryTable } from "./history-table";
import { useHistoryTablePreferences } from "./history-table-preferences";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { useStrategies } from "./api";
import { useBacktestHistoryExtras } from "./experiment-api";
import {
  HistoryPager,
  HistoryEditActions,
  HistoryStrategyGroup,
  HistoryToolbar,
  historyPeriod,
  useHistoryControls,
} from "./history-controls";
import type { HistoryGroup } from "../../../shared/schemas/backtest-history";
import type { BacktestHistoryExtras } from "../../../shared/schemas/backtest-experiments";
import { BacktestHeader, NewBacktestButton } from "./backtest-header";
import {
  formatDateTime,
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
} from "./types";

export function deletableBacktestIds(jobs: readonly JobSummary[]): string[] {
  return jobs.filter((job) => isTerminal(job.status)).map((job) => job.id);
}

export function BacktestJobCard({
  job,
  summary,
  timeframe,
  editing,
  selected,
  deletable,
  selectionDisabled,
  onToggle,
}: {
  job: JobSummary;
  summary?: BacktestHistoryExtras;
  timeframe: string | null;
  editing: boolean;
  selected: boolean;
  deletable?: boolean;
  selectionDisabled?: boolean;
  onToggle: () => void;
}) {
  const running = !isTerminal(job.status);
  const barsProgress =
    job.progressBars !== null && job.totalBars !== null && job.totalBars > 0
      ? Math.round((job.progressBars / job.totalBars) * 100)
      : null;
  const activity = job.progress;
  const progress = activity ? executionProgressPercent(activity) : barsProgress;

  return (
    <HistoryResultCard
      id={job.id}
      href={`/backtests/${job.id}`}
      period={historyPeriod(job.request.period.from, job.request.period.to)}
      date={job.completedAtMs ?? job.createdAtMs}
      description={`${formatUniverseRuleSummary(job.request.universeRule)}${timeframe ? ` · ${timeframeLabel(timeframe)}` : ""}`}
      status={job.status === "COMPLETED" ? null : <StatusBadge status={job.status} />}
      summary={summary}
      editing={editing}
      selected={selected}
      deletable={deletable ?? isTerminal(job.status)}
      selectionDisabled={selectionDisabled}
      onToggle={onToggle}
      error={job.error}
      metrics={job.status === "COMPLETED" && job.metrics ? {
        returnPct: job.metrics.totalReturnPct, cagrPct: job.metrics.cagrPct,
        mddPct: job.metrics.maxDrawdownPct, trades: job.metrics.tradeCount,
      } : undefined}
      progress={running && (progress !== null || activity) ? (
        <div className="space-y-1">
          {progress !== null ? <><Progress value={progress} aria-label={`진행률 ${progress}%`} /><p className="text-xs text-muted-foreground">{progress}%</p></> : null}
          {activity ? <ExecutionProgressSummary progress={activity} compact /> : null}
        </div>
      ) : null}
    />
  );
}

export function BacktestsPage() {
  const controls = useHistoryControls();
  const tablePreferences = useHistoryTablePreferences();
  const columns = tablePreferences.visibleColumns.map((column) => column.id);
  const strategies = useStrategies();
  const edit = useHistoryEditing();
  const [deletion, setDeletion] = useState<{ strategyId: string; ids: string[] } | null>(null);
  const groups = useQuery({
    queryKey: ["backtests", "groups"],
    queryFn: () => api<{ groups: HistoryGroup[] }>("/backtests/groups"),
    refetchInterval: 5_000,
  });
  const limit = controls.view === "cards" ? 6 : 10;
  const pages = useHistoryQueries({
    queries: (groups.data?.groups ?? []).map((group) => {
      const params = new URLSearchParams({
        strategyId: group.strategyId,
        sort: controls.sort,
        dir: controls.dir,
        limit: String(limit),
        offset: String((controls.page(group.strategyId) - 1) * limit),
      });
      const scope = new URLSearchParams(params);
      scope.delete("offset");
      return {
        placeholderKey: group.strategyId,
        placeholderScope: scope.toString(),
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
  const extrasQuery = useBacktestHistoryExtras(sourceIds);
  const extrasBySource = new Map(extrasQuery.data?.summaries.map((item) => [item.jobId, item]) ?? []);
  const deletableIds = deletableBacktestIds(visibleJobs);
  const corrections = (groups.data?.groups ?? []).flatMap((group, index) => {
    const query = pages[index];
    if (
      !query?.data || query.isPlaceholderData ||
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
  }, [correctionKey, correctPages]);
  return (
    <div className="isolate space-y-4">
      <BacktestHeader
        mode="daily"
        actions={<NewBacktestButton mode="daily" />}
      />
      <HistoryToolbar controls={controls} onChange={() => edit.clear()} />
      {groups.isError ? (
        <p role="alert" className="text-destructive">
          이력 그룹을 불러오지 못했습니다.
        </p>
      ) : null}
      {groups.isLoading ? <Skeleton className="h-24 w-full" /> : null}
      {groups.data?.groups.length === 0 ? (
        <p>백테스트가 없습니다. 새 백테스트를 실행해 보세요.</p>
      ) : null}
      {deletion ? <BacktestDeleteDialog mode="daily" ids={deletion.ids} onClose={() => setDeletion(null)} onDeleted={() => { edit.setEditing(deletion.strategyId, false); setDeletion(null); }} /> : null}
      <HistoryLayout columns={columns} view={controls.view}>
        {(groups.data?.groups ?? []).map((group, index) => {
          const query = pages[index];
          const strategy = strategies.data?.strategies.find(
            (s) => s.id === group.strategyId,
          );
          const name = strategy?.name ?? group.strategyId;
          const { editing, selected } = edit.state(group.strategyId);
          const jobs = query?.data?.jobs ?? [];
          const groupDeletableIds = jobs.filter((job) => deletableIds.includes(job.id)).map((job) => job.id);
          const selectedIds = jobs.filter((job) => selected.has(job.id)).map((job) => job.id);
          const selectionTotal = new Set([...groupDeletableIds, ...selectedIds]).size;
          const selectionDisabled = query?.isPlaceholderData || selectedIds.some((id) => !groupDeletableIds.includes(id));
          return (
            <HistoryStrategyGroup
              key={group.strategyId}
              name={name}
              description={strategy?.description}
              total={group.total}
              collapsed={controls.collapsed(group.strategyId)}
              onToggle={() => {
                controls.toggle(group.strategyId);
                edit.setEditing(group.strategyId, false);
              }}
              actions={<HistoryEditActions
                editing={editing}
                onEditingChange={(value) => {
                  if (value && controls.collapsed(group.strategyId)) controls.toggle(group.strategyId);
                  edit.setEditing(group.strategyId, value);
                }}
                total={selectionTotal}
                selected={selectedIds.length}
                pending={deletion !== null}
                selectionDisabled={selectionDisabled}
                onToggleAll={() => edit.toggleAll(group.strategyId, groupDeletableIds)}
                onRemoveSelected={() => setDeletion({ strategyId: group.strategyId, ids: selectedIds })}
              />}
            >
              {query?.isError ? (
                <p role="alert" className="text-destructive">
                  이력을 불러오지 못했습니다.
                </p>
              ) : null}
              {query?.isLoading ? <Skeleton className="h-24 w-full" /> : null}
              {controls.view === "cards" ? (
                <div data-pagination-content aria-busy={query?.isPlaceholderData} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
                  {query?.data?.jobs.map((job) => (
                    <div key={job.id} className="min-w-0 max-w-[360px] space-y-2">
                      <BacktestJobCard
                        job={job}
                        summary={extrasBySource.get(job.id)}
                        timeframe={resolveJobTimeframe(job)}
                        editing={editing}
                        selected={selected.has(job.id)}
                        deletable={deletableIds.includes(job.id) || selected.has(job.id)}
                        selectionDisabled={!selected.has(job.id) && selectionDisabled}
                        onToggle={() => edit.toggleOne(group.strategyId, job.id)}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <HistoryTable columns={columns} busy={query?.isPlaceholderData}>
                    {query?.data?.jobs.map((job) => (
                      <TableRow key={job.id}>
                          <TableCell className="sticky left-0 z-10 bg-background py-3 align-top whitespace-normal">
                            <div className="flex items-center gap-1 whitespace-nowrap">
                              {editing && (deletableIds.includes(job.id) || selected.has(job.id)) ? (
                                <Checkbox
                                  checked={selected.has(job.id)}
                                  disabled={!selected.has(job.id) && selectionDisabled}
                                  onCheckedChange={() => edit.toggleOne(group.strategyId, job.id)}
                                  aria-label={`${formatDateTime(job.createdAtMs)} 백테스트 선택`}
                                />
                              ) : null}
                              {editing ? (
                                <span className="whitespace-nowrap">
                                  {historyPeriod(
                                    job.request.period.from,
                                    job.request.period.to,
                                  )}
                                </span>
                              ) : (
                                <Link
                                  className="whitespace-nowrap underline"
                                  to={`/backtests/${job.id}`}
                                >
                                  {historyPeriod(
                                    job.request.period.from,
                                    job.request.period.to,
                                  )}
                                </Link>
                              )}
                            </div>
                            <HistoryResultDetails
                              id={job.id}
                              status={job.status === "COMPLETED" ? null : <StatusBadge status={job.status} />}
                              summary={extrasBySource.get(job.id)}
                              editing={editing}
                            />
                            {job.error ? (
                              <p className="text-destructive">
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
                          </TableCell>
                          <HistoryMetricCells columns={columns} values={{
                            return: job.metrics?.totalReturnPct,
                            cagr: job.metrics?.cagrPct,
                            mdd: job.metrics?.maxDrawdownPct,
                            date: job.createdAtMs,
                            sharpe: job.metrics?.sharpe,
                            validation: extrasBySource.has(job.id) ? {
                              count: extrasBySource.get(job.id)!.validation.experimentCount,
                              stddev: extrasBySource.get(job.id)!.validation.returns.sampleStdDev,
                            } : undefined,
                          }} />
                        </TableRow>
                    ))}
                </HistoryTable>
              )}
              {query?.data ? (
                <HistoryPager
                  strategyName={name}
                  page={controls.page(group.strategyId)}
                  total={query.data.total}
                  limit={limit}
                  pending={query.isPlaceholderData}
                  onPage={(page) => {
                    controls.setPage(group.strategyId, page);
                    edit.clear(group.strategyId);
                  }}
                />
              ) : null}
            </HistoryStrategyGroup>
          );
        })}
      </HistoryLayout>
    </div>
  );
}
