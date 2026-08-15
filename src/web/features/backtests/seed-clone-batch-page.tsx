import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, formatSignedPct, pnlClass } from '@/lib/format';
import { api } from '@/lib/api-client';
import { useSeedCloneBatch, useStrategies } from './api';
import type { SeedCloneBatchItem, SeedCloneItemStatus } from './types';

const ITEM_STATUS_LABELS: Record<SeedCloneItemStatus, string> = {
  PENDING: '묶음 대기',
  QUEUED: '실행 대기',
  STARTING: '시작 중',
  RUNNING: '실행 중',
  CANCELLING: '취소 중',
  CANCELLED: '취소됨',
  COMPLETED: '완료',
  FAILED: '실패',
  INTERRUPTED: '중단됨',
  DELETED: '삭제됨',
};

export interface SeedCloneMetricSummary {
  readonly count: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly bestSeed: number;
  readonly worstSeed: number;
}

export function summarizeSeedCloneMetrics(
  items: readonly SeedCloneBatchItem[],
): SeedCloneMetricSummary | null {
  const completed = items
    .filter((item) => item.status === 'COMPLETED' && item.metrics !== null)
    .map((item) => ({ seed: item.randomSeed, value: item.metrics!.totalReturnPct }))
    .sort((left, right) => left.value - right.value);
  if (completed.length === 0) return null;
  const middle = Math.floor(completed.length / 2);
  const median = completed.length % 2 === 0
    ? (completed[middle - 1]!.value + completed[middle]!.value) / 2
    : completed[middle]!.value;
  return {
    count: completed.length,
    median,
    min: completed[0]!.value,
    max: completed.at(-1)!.value,
    worstSeed: completed[0]!.seed,
    bestSeed: completed.at(-1)!.seed,
  };
}

export function SeedCloneBatchPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const query = useSeedCloneBatch(id);
  const strategies = useStrategies();
  const cancel = useMutation({
    mutationFn: () => api(`/backtest-clone-batches/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.info('남은 난수 시드 실행을 취소했습니다');
      void queryClient.invalidateQueries({ queryKey: ['backtest-clone-batches'] });
    },
    onError: (error) => toast.error(error.message),
  });
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>난수 시드 실험을 불러올 수 없습니다</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (query.isLoading || !query.data) return <Skeleton className="h-64 w-full" />;

  const batch = query.data.batch;
  const strategyName = strategies.data?.strategies.find((strategy) => strategy.id === batch.strategyId)?.name;
  const terminalCount = batch.completedCount + batch.failedCount + batch.cancelledCount
    + batch.interruptedCount + batch.deletedCount;
  const progress = Math.round((terminalCount / batch.totalCount) * 100);
  const metrics = summarizeSeedCloneMetrics(batch.items);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">새 난수 시드 실험</h2>
        <Badge variant={batch.status === 'FAILED' ? 'destructive' : batch.status === 'COMPLETED' ? 'default' : batch.status === 'CANCELLED' ? 'outline' : 'secondary'}>
          {batch.status === 'ACTIVE'
            ? '진행 중'
            : batch.status === 'CANCELLING'
              ? '취소 중'
              : batch.status === 'COMPLETED'
                ? '완료'
                : batch.status === 'CANCELLED'
                  ? '취소됨'
                  : '실패'}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{formatDateTime(batch.createdAtMs)}</span>
          {batch.status === 'ACTIVE' ? (
            <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              남은 실행 취소
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <span>{strategyName ?? batch.strategyId} · 총 {batch.totalCount}개</span>
            <Link className="text-primary underline-offset-4 hover:underline" to={`/backtests/${batch.sourceJobId}`}>
              원본 백테스트
            </Link>
          </div>
          <Progress value={progress} aria-label={`실험 진행률 ${progress}%`} />
          <p className="text-xs text-muted-foreground">
            완료 {batch.completedCount} · 실행 {batch.runningCount} · 실행 대기 {batch.queuedCount}
            {' · '}묶음 대기 {batch.pendingCount} · 실패 {batch.failedCount}
          </p>
        </CardContent>
      </Card>

      {metrics ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card><CardHeader><CardTitle className="text-sm">중앙 수익률</CardTitle></CardHeader><CardContent className={pnlClass(metrics.median)}>{formatSignedPct(metrics.median)}</CardContent></Card>
          <Card><CardHeader><CardTitle className="text-sm">최고</CardTitle></CardHeader><CardContent><p className={pnlClass(metrics.max)}>{formatSignedPct(metrics.max)}</p><p className="text-xs text-muted-foreground">시드 {metrics.bestSeed}</p></CardContent></Card>
          <Card><CardHeader><CardTitle className="text-sm">최저</CardTitle></CardHeader><CardContent><p className={pnlClass(metrics.min)}>{formatSignedPct(metrics.min)}</p><p className="text-xs text-muted-foreground">시드 {metrics.worstSeed}</p></CardContent></Card>
        </div>
      ) : null}

      {batch.error ? (
        <Alert variant="destructive"><AlertDescription>{batch.error}</AlertDescription></Alert>
      ) : null}

      <Card>
        <CardHeader><CardTitle className="text-base">실행 목록</CardTitle></CardHeader>
        <CardContent>
          <div className="max-h-[36rem] overflow-auto rounded-md border">
            <Table>
              <TableHeader><TableRow><TableHead>#</TableHead><TableHead>난수 시드</TableHead><TableHead>상태</TableHead><TableHead className="text-right">수익률</TableHead></TableRow></TableHeader>
              <TableBody>
                {batch.items.map((item) => (
                  <TableRow key={item.ordinal}>
                    <TableCell>{item.ordinal + 1}</TableCell>
                    <TableCell className="font-mono text-xs">{item.randomSeed}</TableCell>
                    <TableCell>
                      {item.jobId ? <Link className="hover:underline" to={`/backtests/${item.jobId}`}>{ITEM_STATUS_LABELS[item.status]}</Link> : ITEM_STATUS_LABELS[item.status]}
                    </TableCell>
                    <TableCell className={`text-right ${pnlClass(item.metrics?.totalReturnPct ?? null)}`}>
                      {item.metrics ? formatSignedPct(item.metrics.totalReturnPct) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
