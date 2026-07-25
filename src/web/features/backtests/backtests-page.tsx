import { Plus } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useBacktests } from './api';
import { formatDateTime, formatSignedPct, pnlClass } from '@/lib/format';
import { StatusBadge } from './status-badge';
import { isTerminal, type JobSummary } from './types';

function JobCard({ job }: { job: JobSummary }) {
  const running = !isTerminal(job.status);
  const progress =
    job.progressBars !== null && job.totalBars !== null && job.totalBars > 0
      ? Math.round((job.progressBars / job.totalBars) * 100)
      : null;

  return (
    <Link to={`/backtests/${job.id}`} className="block">
      <Card className="transition-colors hover:bg-muted/40">
        <CardContent className="space-y-2 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{job.strategyId}</span>
            <StatusBadge status={job.status} />
            <span className="ml-auto text-xs text-muted-foreground">
              {formatDateTime(job.createdAtMs)}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {job.request.universe.symbols.join(', ')} · {job.request.period.from} ~{' '}
            {job.request.period.to}
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
              <span className="text-muted-foreground">
                MDD {formatSignedPct(job.metrics.maxDrawdownPct)}
              </span>
              <span className="text-muted-foreground">거래 {job.metrics.tradeCount}건</span>
            </div>
          ) : null}
          {job.error ? <p className="text-xs text-destructive">{job.error}</p> : null}
        </CardContent>
      </Card>
    </Link>
  );
}

export function BacktestsPage() {
  const { data, isLoading } = useBacktests(5_000);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">백테스트</h2>
        <Button asChild className="h-11">
          <Link to="/backtests/new">
            <Plus data-icon="inline-start" />새 백테스트
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : data && data.jobs.length > 0 ? (
        <div className="space-y-3">
          {data.jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
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
