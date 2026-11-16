import { useHistoryQueries } from "./use-history-queries";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/info-hint";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { useStrategies } from "./api";
import { useBacktestHistoryExtras } from "./experiment-api";
import {
  HistoryPager,
  HistorySelectionActions,
  HistoryStrategyGroup,
  HistoryToolbar,
  historyPeriod,
  useHistoryControls,
} from "./history-controls";
import type { HistoryGroup } from "../../../shared/schemas/backtest-history";
import { BacktestHeader, NewBacktestButton } from "./backtest-header";
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
} from "./types";

export function deletableBacktestIds(jobs: readonly JobSummary[]): string[] {
  return jobs.filter((job) => isTerminal(job.status)).map((job) => job.id);
}

export function toggleAllBacktests(
  selected: ReadonlySet<string>,
  deletableIds: readonly string[],
): ReadonlySet<string> {
  const allSelected =
    deletableIds.length > 0 && deletableIds.every((id) => selected.has(id));
  return allSelected ? new Set() : new Set(deletableIds);
}

function ExperimentLinks({ jobId }: { jobId: string }) {
  return (
    <span className="relative z-10 inline-flex gap-1">
      <Button asChild variant="outline" size="sm" className="h-5 px-2 text-xs"><Link to={`/backtests/${jobId}/seeds`}>난수</Link></Button>
      <Button asChild variant="outline" size="sm" className="h-5 px-2 text-xs"><Link to={`/backtests/${jobId}/validations`}>검증</Link></Button>
    </span>
  );
}

function distribution(count: number | undefined, stddev: number | null | undefined): string {
  return count === undefined ? "—" : `${count} (${stddev == null ? "—" : `${stddev.toFixed(2)}%p`})`;
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
    <Card className="relative transition-colors hover:bg-muted/40">
      <CardContent className="space-y-2 py-4">
        <div className="flex items-start justify-between gap-2">
          <StatusBadge status={job.status} />
          {!editing ? <ExperimentLinks jobId={job.id} /> : null}
        </div>
        <div className="flex items-baseline justify-between gap-2 whitespace-nowrap">
          {editing ? (
            <p className="text-xs font-medium">{historyPeriod(job.request.period.from, job.request.period.to)}</p>
          ) : (
            <Link className="text-xs font-medium underline after:absolute after:inset-0" to={`/backtests/${job.id}`}>
              {historyPeriod(job.request.period.from, job.request.period.to)}
            </Link>
          )}
          <time
            className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
            dateTime={new Date(job.completedAtMs ?? job.createdAtMs).toISOString()}
            title={formatDateTime(job.completedAtMs ?? job.createdAtMs)}
          >
            {formatDateTime(job.completedAtMs ?? job.createdAtMs).replace(/^\d{2}/, "")}
          </time>
        </div>
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
    return card;
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
    controls.collapsed(groups.data?.groups[index]?.strategyId ?? "") || query.isPlaceholderData
      ? []
      : (query.data?.jobs ?? []),
  );
  const sourceIds = visibleJobs.map((job) => job.id).sort();
  const extrasQuery = useBacktestHistoryExtras(sourceIds);
  const extrasBySource = new Map(extrasQuery.data?.summaries.map((item) => [item.jobId, item]) ?? []);
  // 재조회 중에는 직전 성공 결과를 유지해 체크박스와 선택 상태가 흔들리지 않게 한다.
  const extrasReady = sourceIds.length === 0 || (extrasQuery.isSuccess && !extrasQuery.isError);
  const deletableIds = extrasReady
    ? deletableBacktestIds(visibleJobs).filter((id) => {
        const extras = extrasBySource.get(id);
        return extras !== undefined && extras.seed.activeCount === 0 && extras.validation.experimentCount === 0;
      })
    : [];
  const selectedIds = deletableIds.filter((id) => selected.has(id));
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
    setSelected((previous) => (previous.size ? new Set() : previous));
  }, [correctionKey, correctPages]);
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["backtests"] });
    void client.invalidateQueries({ queryKey: ["backtest-experiments"] });
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
  const toggleOne = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="isolate space-y-4">
      <BacktestHeader
        mode="daily"
        actions={<NewBacktestButton mode="daily" />}
      />
      <HistoryToolbar
        controls={controls}
        onChange={clear}
        editing={editing}
        onEditingChange={visibleJobs.length > 0 || editing ? (value) => {
          setEditing(value);
          clear();
        } : undefined}
      />
      {editing ? (
        <HistorySelectionActions
          total={deletableIds.length}
          selected={selectedIds.length}
          pending={remove.isPending}
          onToggleAll={() => setSelected(toggleAllBacktests(selected, deletableIds))}
          onRemoveSelected={() => remove.mutate(selectedIds)}
          onRemoveAll={() => remove.mutate(deletableIds)}
        />
      ) : null}
      {editing && [...extrasBySource.values()].some((item) => item.validation.experimentCount > 0) ? (
        <p className="text-sm text-muted-foreground">기간검증이 연결된 기록은 검증 실험을 먼저 삭제해야 선택할 수 있습니다.</p>
      ) : null}
      {extrasQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          실험 정보를 불러오지 못해 원본 삭제가 비활성화되었습니다.
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
        return (
          <HistoryStrategyGroup
            key={group.strategyId}
            name={name}
            description={strategy?.description}
            total={group.total}
            collapsed={controls.collapsed(group.strategyId)}
            onToggle={() => {
              controls.toggle(group.strategyId);
              clear();
            }}
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
                      timeframe={resolveJobTimeframe(job)}
                      editing={editing}
                      selected={selected.has(job.id)}
                      deletable={deletableIds.includes(job.id)}
                      onToggle={() => toggleOne(job.id)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <table data-pagination-content aria-busy={query?.isPlaceholderData} className="w-full table-fixed text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="w-[48%] py-2 text-left sm:w-[32%] lg:w-[25%]">기간</th>
                    <th className="text-right">수익률</th>
                    <th className="text-right">CAGR</th>
                    <th className="hidden text-right sm:table-cell">MDD</th>
                    <th className="hidden text-right lg:table-cell">초과수익률</th>
                    <th className="hidden text-right lg:table-cell">Sharpe</th>
                    <th className="hidden text-right md:table-cell">
                      난수 <InfoHint label="난수 시드 통계 설명">건수는 난수 시드 실험 수이며 괄호는 완료된 실행 중 유효한 수익률의 표본 표준편차입니다.</InfoHint>
                    </th>
                    <th className="hidden text-right md:table-cell">
                      검증 <InfoHint label="기간 검증 통계 설명">건수는 기간 검증 실험 수이며 괄호는 완료된 실험별 OOS 평균 수익률 분포의 표본 표준편차입니다.</InfoHint>
                    </th>
                    <th className="hidden text-right sm:table-cell">실행일</th>
                  </tr>
                </thead>
                <tbody>
                  {query?.data?.jobs.map((job) => (
                    <tr key={job.id} className="border-t">
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
                            {!editing ? <ExperimentLinks jobId={job.id} /> : null}{" "}
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
                          {formatSignedPct(job.metrics?.totalReturnPct ?? null)}
                        </td>
                        <td
                          className={`text-right ${pnlClass(job.metrics?.cagrPct ?? null)}`}
                        >
                          {formatSignedPct(job.metrics?.cagrPct ?? null)}
                        </td>
                        <td className={`hidden text-right sm:table-cell ${pnlClass(job.metrics?.maxDrawdownPct)}`}>
                          {formatSignedPct(job.metrics?.maxDrawdownPct ?? null)}
                        </td>
                        <td className={`hidden text-right lg:table-cell ${pnlClass(extrasBySource.get(job.id)?.benchmarkExcessReturnPct)}`}>
                          {formatSignedPct(extrasBySource.get(job.id)?.benchmarkExcessReturnPct ?? null)}
                        </td>
                        <td className={`hidden text-right lg:table-cell ${job.metrics?.sharpe == null ? "text-muted-foreground" : job.metrics.sharpe < 0 ? "text-loss" : job.metrics.sharpe >= 1 ? "text-gain" : "text-foreground"}`}>
                          {job.metrics?.sharpe == null ? "—" : job.metrics.sharpe.toFixed(2)}
                        </td>
                        <td className="hidden text-right md:table-cell">{distribution(extrasBySource.get(job.id)?.seed.batchCount, extrasBySource.get(job.id)?.seed.returns.sampleStdDev)}</td>
                        <td className="hidden text-right md:table-cell">{distribution(extrasBySource.get(job.id)?.validation.experimentCount, extrasBySource.get(job.id)?.validation.returns.sampleStdDev)}</td>
                        <td className="hidden pl-2 text-right sm:table-cell">
                          {formatDateTime(job.createdAtMs)}
                        </td>
                      </tr>
                  ))}
                </tbody>
              </table>
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
                  clear();
                }}
              />
            ) : null}
          </HistoryStrategyGroup>
        );
      })}
    </div>
  );
}
