import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '@/lib/api-client';
import { InfoHint } from '@/components/info-hint';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useBacktests } from './api';
import { formatDateTime, formatSignedPct, pnlClass, timeframeLabel } from '@/lib/format';
import { groupJobsByStrategy } from './job-groups';
import { resolveJobTimeframe } from './job-timeframe';
import { StatusBadge } from './status-badge';
import { formatUniverseSummary } from './universe-summary';
import { isTerminal, type JobSummary } from './types';

function JobCard({
  job,
  datasetName,
  timeframe,
}: {
  job: JobSummary;
  datasetName: string | null;
  timeframe: string | null;
}) {
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
            <StatusBadge status={job.status} />
            <span className="ml-auto text-xs text-muted-foreground">
              {formatDateTime(job.createdAtMs)}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {formatUniverseSummary(
              datasetName,
              job.datasetId,
              job.request.universe.symbols.length,
            )}{' '}
            · {job.request.period.from} ~ {job.request.period.to}
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

interface StrategySummary {
  id: string;
  version: string;
  name: string;
  description: string;
}

export function BacktestsPage() {
  const { data, isLoading } = useBacktests(5_000);
  const strategies = useQuery({
    queryKey: ['strategies'],
    queryFn: () => api<{ strategies: StrategySummary[] }>('/strategies'),
  });
  const strategyById = new Map((strategies.data?.strategies ?? []).map((s) => [s.id, s]));

  // 설명 줄이 데이터셋 이름과 종목 수만 적으므로 종목명 조회가 필요 없다 — 카드마다
  // 종목 이름을 나열하던 시절에는 잡 수 × 5종목을 매 5초 갱신마다 다시 물었다.
  const datasets = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api<{ datasets: Array<{ id: string; name: string }> }>('/datasets'),
  });
  const datasetNameById = new Map(
    (datasets.data?.datasets ?? []).map((dataset) => [dataset.id, dataset.name]),
  );

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
        <div className="space-y-6">
          {groupJobsByStrategy(data.jobs).map((group) => {
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
                  <JobCard
                    key={job.id}
                    job={job}
                    datasetName={datasetNameById.get(job.datasetId) ?? null}
                    timeframe={resolveJobTimeframe(job)}
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
