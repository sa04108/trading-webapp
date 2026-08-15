import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dices, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { InfoHint } from '@/components/info-hint';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api-client';
import { useBacktests, useSeedCloneBatches, useStrategies } from './api';
import { formatDateTime, formatSignedPct, pnlClass, timeframeLabel } from '@/lib/format';
import { groupJobsByStrategy } from './job-groups';
import { resolveJobTimeframe } from './job-timeframe';
import { StatusBadge } from './status-badge';
import { formatUniverseRuleSummary } from './universe-summary';
import { isTerminal, type JobSummary, type SeedCloneBatchSummary } from './types';

export function deletableBacktestIds(jobs: readonly JobSummary[]): string[] {
  return jobs.filter((job) => isTerminal(job.status)).map((job) => job.id);
}

export function toggleAllBacktests(
  selected: ReadonlySet<string>,
  deletableIds: readonly string[],
): ReadonlySet<string> {
  const allSelected = deletableIds.length > 0 && deletableIds.every((id) => selected.has(id));
  return allSelected ? new Set() : new Set(deletableIds);
}

export function BacktestJobCard({
  job,
  timeframe,
  editing,
  selected,
  onToggle,
}: {
  job: JobSummary;
  timeframe: string | null;
  editing: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const running = !isTerminal(job.status);
  const progress =
    job.progressBars !== null && job.totalBars !== null && job.totalBars > 0
      ? Math.round((job.progressBars / job.totalBars) * 100)
      : null;

  const card = (
    <Card className="transition-colors hover:bg-muted/40">
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={job.status} />
          <span className="ml-auto text-xs text-muted-foreground">
            {formatDateTime(job.createdAtMs)}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {formatUniverseRuleSummary(job.request.universeRule)} · {job.request.period.from} ~{' '}
          {job.request.period.to}
          {timeframe ? ` · ${timeframeLabel(timeframe)}` : ''}
        </div>
        {running && progress !== null ? (
          <div className="space-y-1">
            <Progress value={progress} aria-label={`진행률 ${progress}%`} />
            <p className="text-xs text-muted-foreground">{progress}%</p>
          </div>
        ) : null}
        {job.status === 'COMPLETED' && job.metrics ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span className={pnlClass(job.metrics.totalReturnPct)}>
              수익률 {formatSignedPct(job.metrics.totalReturnPct)}
            </span>
            <span className={pnlClass(job.metrics.cagrPct)}>
              CAGR {formatSignedPct(job.metrics.cagrPct)}
            </span>
            <span className="text-muted-foreground">
              MDD {formatSignedPct(job.metrics.maxDrawdownPct)}
            </span>
            <span className="text-muted-foreground">거래 {job.metrics.tradeCount}건</span>
          </div>
        ) : null}
        {job.error ? <p className="text-xs text-destructive">{job.error}</p> : null}
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

  if (!isTerminal(job.status)) {
    return (
      <div className="flex items-start gap-3">
        <span className="mt-5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 opacity-70">{card}</div>
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

export function SeedCloneBatchCard({ batch }: { batch: SeedCloneBatchSummary }) {
  const terminal = batch.completedCount + batch.failedCount + batch.cancelledCount
    + batch.interruptedCount + batch.deletedCount;
  const progress = Math.round((terminal / batch.totalCount) * 100);
  return (
    <Link to={`/backtests/batches/${batch.id}`} className="block">
      <Card className="transition-colors hover:bg-muted/40">
        <CardContent className="space-y-2 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Dices className="size-4" />
            <span className="font-medium">새 난수 시드 {batch.totalCount}개</span>
            <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(batch.createdAtMs)}</span>
          </div>
          <Progress value={progress} aria-label={`난수 시드 실험 진행률 ${progress}%`} />
          <p className="text-xs text-muted-foreground">
            완료 {batch.completedCount} · 실행 {batch.runningCount} · 실행 대기 {batch.queuedCount}
            {' · '}묶음 대기 {batch.pendingCount} · 실패 {batch.failedCount}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

export function BacktestsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useBacktests(5_000);
  const batchesQuery = useSeedCloneBatches(5_000);
  const strategies = useStrategies();
  const strategyById = new Map((strategies.data?.strategies ?? []).map((s) => [s.id, s]));
  const jobs = (data?.jobs ?? []).filter((job) => !job.cloneBatchId);
  const batches = batchesQuery.data?.batches ?? [];
  const deletableIds = deletableBacktestIds(jobs);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectedIds = deletableIds.filter((id) => selected.has(id));
  const allSelected = deletableIds.length > 0 && selectedIds.length === deletableIds.length;

  const remove = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => api(`/backtests/${id}`, { method: 'DELETE' }))),
    onSuccess: (_result, ids) => {
      toast.success(`백테스트 ${ids.length}개를 삭제했습니다`);
      setSelected(new Set());
      setEditing(false);
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['backtests'] }),
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">백테스트</h2>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {editing ? (
            <>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() => setSelected(toggleAllBacktests(selected, deletableIds))}
                  aria-label="전체 선택"
                />
                전체 선택
              </label>
              <Button
                variant="destructive"
                size="sm"
                disabled={selectedIds.length === 0 || remove.isPending}
                onClick={() => remove.mutate(selectedIds)}
              >
                선택 삭제 ({selectedIds.length})
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={deletableIds.length === 0 || remove.isPending}
                onClick={() => remove.mutate(deletableIds)}
              >
                전체 삭제
              </Button>
            </>
          ) : null}
          {jobs.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing((previous) => !previous);
                setSelected(new Set());
              }}
            >
              {editing ? '완료' : '편집'}
            </Button>
          ) : null}
          <Button asChild className="h-11">
            <Link to="/backtests/new">
              <Plus data-icon="inline-start" />새 백테스트
            </Link>
          </Button>
        </div>
      </div>

      {isLoading || batchesQuery.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : jobs.length > 0 || batches.length > 0 ? (
        <div className="space-y-6">
          {batches.length > 0 ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">난수 시드 실험</h3>
              {batches.map((batch) => <SeedCloneBatchCard key={batch.id} batch={batch} />)}
            </section>
          ) : null}
          {groupJobsByStrategy(jobs).map((group) => {
            const strategy = strategyById.get(group.strategyId);
            return (
              <section key={group.strategyId} className="space-y-3">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-sm font-semibold">{strategy?.name ?? group.strategyId}</h3>
                  {strategy?.description ? (
                    <InfoHint label={`${strategy.name} 전략 설명`}>
                      <p className="leading-relaxed">{strategy.description}</p>
                    </InfoHint>
                  ) : null}
                </div>
                {group.jobs.map((job) => (
                  <BacktestJobCard
                    key={job.id}
                    job={job}
                    timeframe={resolveJobTimeframe(job)}
                    editing={editing}
                    selected={selected.has(job.id)}
                    onToggle={() => toggleOne(job.id)}
                  />
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            백테스트가 없습니다. 새 백테스트를 실행해 보세요.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
