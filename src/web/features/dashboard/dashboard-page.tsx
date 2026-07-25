import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useBacktests } from '../backtests/api';
import { formatDateTime, formatSignedPct, pnlClass } from '../backtests/format';
import { StatusBadge } from '../backtests/status-badge';
import { isTerminal } from '../backtests/types';

interface SystemInfo {
  version: string;
  uptimeSeconds: number;
  databaseSizeBytes: number;
  freeDiskBytes: number | null;
  freeMemoryBytes: number;
  queueLength: number;
  runningJobs: number;
}

function formatGb(bytes: number | null): string {
  if (bytes === null) return '-';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function DashboardPage() {
  const { data: backtests, isLoading } = useBacktests(5_000);
  const { data: info } = useQuery({
    queryKey: ['system', 'info'],
    queryFn: () => api<SystemInfo>('/system/info'),
    refetchInterval: 30_000,
  });
  const { data: datasets } = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api<{ datasets: Array<{ id: string; name: string }> }>('/datasets'),
  });

  const jobs = backtests?.jobs ?? [];
  const active = jobs.filter((job) => !isTerminal(job.status));
  const recentCompleted = jobs.filter((job) => job.status === 'COMPLETED').slice(0, 3);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">대시보드</h2>
        <Button asChild className="h-11">
          <Link to="/backtests/new">
            <Plus data-icon="inline-start" />
            빠른 백테스트
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">실행 중 작업</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : active.length === 0 ? (
              <p className="text-sm text-muted-foreground">실행 중인 백테스트가 없습니다.</p>
            ) : (
              active.map((job) => {
                const progress =
                  job.progressBars !== null && job.totalBars !== null && job.totalBars > 0
                    ? Math.round((job.progressBars / job.totalBars) * 100)
                    : null;
                return (
                  <Link key={job.id} to={`/backtests/${job.id}`} className="block space-y-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{job.strategyId}</span>
                      <StatusBadge status={job.status} />
                      <span className="ml-auto text-xs text-muted-foreground">
                        {progress !== null ? `${progress}%` : ''}
                      </span>
                    </div>
                    <Progress value={progress ?? 0} />
                  </Link>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">최근 결과</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentCompleted.length === 0 ? (
              <p className="text-sm text-muted-foreground">완료된 결과가 없습니다.</p>
            ) : (
              recentCompleted.map((job) => (
                <Link
                  key={job.id}
                  to={`/backtests/${job.id}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="font-medium">{job.strategyId}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(job.completedAtMs)}
                  </span>
                  {job.metrics ? (
                    <span className={cn('ml-auto tabular-nums', pnlClass(job.metrics.totalReturnPct))}>
                      {formatSignedPct(job.metrics.totalReturnPct)}
                    </span>
                  ) : null}
                  <ArrowRight className="size-3 text-muted-foreground" />
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">데이터</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {datasets ? (
              datasets.datasets.length > 0 ? (
                <p>
                  데이터셋 {datasets.datasets.length}개 —{' '}
                  <Link to="/datasets" className="underline underline-offset-4">
                    커버리지 확인
                  </Link>
                </p>
              ) : (
                <p className="text-muted-foreground">
                  데이터셋이 없습니다.{' '}
                  <Link to="/datasets" className="underline underline-offset-4">
                    CSV 가져오기
                  </Link>
                </p>
              )
            ) : (
              <Skeleton className="h-6 w-full" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">서버 상태</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {info ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <span className="text-muted-foreground">대기 작업</span>
                <span className="text-right tabular-nums">{info.queueLength}</span>
                <span className="text-muted-foreground">실행 작업</span>
                <span className="text-right tabular-nums">{info.runningJobs}</span>
                <span className="text-muted-foreground">남은 디스크</span>
                <span className="text-right tabular-nums">{formatGb(info.freeDiskBytes)}</span>
                <span className="text-muted-foreground">여유 메모리</span>
                <span className="text-right tabular-nums">
                  {formatGb(info.freeMemoryBytes)}
                </span>
              </div>
            ) : (
              <Skeleton className="h-16 w-full" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
