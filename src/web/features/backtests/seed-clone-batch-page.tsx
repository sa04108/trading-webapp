import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, formatNumber, formatSignedPct, pnlClass } from '@/lib/format';
import { api } from '@/lib/api-client';
import { useSeedCloneBatch, useStrategies } from './api';
import { summarizeSeedCloneMetrics } from './seed-clone-statistics';
import type { SeedCloneItemStatus } from './types';

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

function formatPctMagnitude(value: number | null): string {
  return value === null ? '—' : `${formatNumber(value)}%`;
}

export function SeedCloneBatchPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
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
  const remove = useMutation({
    mutationFn: () => api(`/backtest-clone-batches/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteOpen(false);
      toast.success('난수 시드 실험을 삭제했습니다');
      void queryClient.invalidateQueries({ queryKey: ['backtests'] });
      void queryClient.invalidateQueries({ queryKey: ['backtest-clone-batches'] });
      void navigate('/backtests');
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
        <h2 className="text-lg font-semibold">난수 시드 실험</h2>
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
          {batch.status !== 'ACTIVE' && batch.status !== 'CANCELLING' ? (
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
              실험 삭제
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
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card><CardHeader><CardTitle className="text-sm">평균 수익률</CardTitle></CardHeader><CardContent><p className={pnlClass(metrics.totalReturn.mean)}>{formatSignedPct(metrics.totalReturn.mean)}</p><p className="text-xs text-muted-foreground">완료 {metrics.totalReturn.count}개 기준</p></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-sm">수익률 표준편차</CardTitle></CardHeader><CardContent><p>{formatPctMagnitude(metrics.totalReturn.sampleStdDev)}</p><p className="text-xs text-muted-foreground">표본 표준편차 (n-1)</p></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-sm">평균 Sharpe</CardTitle></CardHeader><CardContent><p>{formatNumber(metrics.sharpe?.mean ?? null)}</p><p className="text-xs text-muted-foreground">유효 지표 {metrics.sharpe?.count ?? 0}개</p></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-sm">Sharpe 표준편차</CardTitle></CardHeader><CardContent><p>{formatNumber(metrics.sharpe?.sampleStdDev ?? null)}</p><p className="text-xs text-muted-foreground">표본 표준편차 (n-1)</p></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-sm">중앙 수익률</CardTitle></CardHeader><CardContent className={pnlClass(metrics.totalReturn.median)}>{formatSignedPct(metrics.totalReturn.median)}</CardContent></Card>
            <Card><CardHeader><CardTitle className="text-sm">평균 MDD</CardTitle></CardHeader><CardContent className={pnlClass(metrics.maxDrawdown.mean)}>{formatSignedPct(metrics.maxDrawdown.mean)}</CardContent></Card>
            <Card><CardHeader><CardTitle className="text-sm">최고 수익률</CardTitle></CardHeader><CardContent><p className={pnlClass(metrics.totalReturn.max)}>{formatSignedPct(metrics.totalReturn.max)}</p><p className="text-xs text-muted-foreground">시드 {metrics.bestSeed}</p></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-sm">최저 수익률</CardTitle></CardHeader><CardContent><p className={pnlClass(metrics.totalReturn.min)}>{formatSignedPct(metrics.totalReturn.min)}</p><p className="text-xs text-muted-foreground">시드 {metrics.worstSeed}</p></CardContent></Card>
          </div>
          <Alert>
            <AlertTitle>seed 순서 민감성 지표</AlertTitle>
            <AlertDescription>
              이 표준편차는 동률 종목과 동시 매수 순서가 결과에 미치는 영향을 측정합니다.
              시장 가격 경로를 바꾼 Monte Carlo 결과는 아닙니다.
            </AlertDescription>
          </Alert>
        </>
      ) : null}

      {batch.error ? (
        <Alert variant="destructive"><AlertDescription>{batch.error}</AlertDescription></Alert>
      ) : null}

      <Card>
        <CardHeader><CardTitle className="text-base">실행 목록</CardTitle></CardHeader>
        <CardContent>
          <div className="max-h-[36rem] overflow-auto rounded-md border">
            <Table>
              <TableHeader><TableRow><TableHead>#</TableHead><TableHead>난수 시드</TableHead><TableHead>상태</TableHead><TableHead className="text-right">수익률</TableHead><TableHead className="text-right">Sharpe</TableHead><TableHead className="text-right">MDD</TableHead></TableRow></TableHeader>
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
                    <TableCell className="text-right">
                      {item.metrics ? formatNumber(item.metrics.sharpe) : '—'}
                    </TableCell>
                    <TableCell className={`text-right ${pnlClass(item.metrics?.maxDrawdownPct ?? null)}`}>
                      {item.metrics ? formatSignedPct(item.metrics.maxDrawdownPct) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>난수 시드 실험을 삭제할까요?</DialogTitle>
            <DialogDescription>
              이 실험에 포함된 모든 seed 백테스트와 결과가 함께 삭제됩니다. 원본
              백테스트는 유지됩니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>취소</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
