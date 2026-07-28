import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, SlidersHorizontal, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useBacktestLive, useBacktestSeries, useBacktestTrades } from './api';
import {
  formatDateTime,
  formatDuration,
  formatKrw,
  formatNumber,
  formatSignedKrw,
  formatSignedPct,
  pnlClass,
} from '@/lib/format';
import { DrawdownChart, EquityChart, MonthlyReturnsChart } from './result-charts';
import { StatusBadge } from './status-badge';
import { isTerminal, type BacktestMetrics, type JobSummary, type RunMetadata } from './types';

function MetricCards({ metrics }: { metrics: BacktestMetrics }) {
  const cards = [
    {
      label: '누적 수익률',
      value: formatSignedPct(metrics.totalReturnPct),
      className: pnlClass(metrics.totalReturnPct),
    },
    { label: 'CAGR', value: formatSignedPct(metrics.cagrPct), className: pnlClass(metrics.cagrPct) },
    {
      label: 'MDD',
      value: formatSignedPct(metrics.maxDrawdownPct),
      className: pnlClass(metrics.maxDrawdownPct),
    },
    { label: 'Sharpe', value: formatNumber(metrics.sharpe), className: '' },
    {
      label: '승률',
      value: metrics.winRate === null ? '-' : `${metrics.winRate.toFixed(1)}%`,
      className: '',
    },
    { label: '거래 수', value: `${metrics.tradeCount}건`, className: '' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="px-4 py-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className={cn('text-lg font-semibold tabular-nums', card.className)}>{card.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TradesSection({ jobId, symbols }: { jobId: string; symbols: string[] }) {
  const PAGE = 50;
  const [symbol, setSymbol] = useState<string>('ALL');
  const [page, setPage] = useState(0);
  const { data, isLoading } = useBacktestTrades(
    jobId,
    { limit: PAGE, offset: page * PAGE, ...(symbol !== 'ALL' ? { symbol } : {}) },
    true,
  );
  const trades = data?.trades ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">거래 내역</CardTitle>
        <Select
          value={symbol}
          onValueChange={(value) => {
            setSymbol(value);
            setPage(0);
          }}
        >
          <SelectTrigger className="h-9 w-36" aria-label="종목 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 종목</SelectItem>
            {symbols.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : trades.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">거래가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>종목</TableHead>
                  <TableHead className="text-right">수량</TableHead>
                  <TableHead>진입</TableHead>
                  <TableHead>청산</TableHead>
                  <TableHead className="text-right">순손익</TableHead>
                  <TableHead className="text-right">수익률</TableHead>
                  <TableHead>보유</TableHead>
                  <TableHead>사유</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((trade) => (
                  <TableRow key={trade.id}>
                    <TableCell className="font-medium">{trade.symbol}</TableCell>
                    <TableCell className="text-right tabular-nums">{trade.quantity}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(trade.entryTsMs)}
                      <br />
                      <span className="text-muted-foreground">{formatKrw(trade.entryPrice)}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(trade.exitTsMs)}
                      <br />
                      <span className="text-muted-foreground">{formatKrw(trade.exitPrice)}</span>
                    </TableCell>
                    <TableCell
                      className={cn('text-right tabular-nums', pnlClass(trade.netPnl))}
                    >
                      {formatSignedKrw(trade.netPnl)}
                    </TableCell>
                    <TableCell
                      className={cn('text-right tabular-nums', pnlClass(trade.returnPct))}
                    >
                      {formatSignedPct(trade.returnPct)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDuration(trade.holdingTimeMs)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {trade.exitReason === 'STOP'
                        ? '손절'
                        : trade.exitReason === 'TAKE_PROFIT'
                          ? '익절'
                          : (trade.exitReason ?? '-')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            이전
          </Button>
          <span className="text-xs text-muted-foreground">{page + 1} 페이지</span>
          <Button
            variant="outline"
            size="sm"
            disabled={trades.length < PAGE}
            onClick={() => setPage((p) => p + 1)}
          >
            다음
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RunMetadataCard({ run, job }: { run: RunMetadata; job: JobSummary }) {
  const warnings = run.warningsJson ? (JSON.parse(run.warningsJson) as string[]) : [];
  const rows: Array<[string, string]> = [
    ['전략', `${run.strategyId} v${run.strategyVersion}`],
    ['전략 해시', run.strategySourceHash.slice(0, 16)],
    ['데이터셋', `${run.datasetId} (v${run.datasetVersion})`],
    ['데이터 해시', run.datasetHash.slice(0, 16)],
    ['엔진 버전', run.engineVersion],
    ['수수료 모델', run.feeModelVersion],
    ['슬리피지 모델', run.slippageModelVersion],
    ['Random seed', String(run.randomSeed)],
    ['Git commit', run.gitCommitSha.slice(0, 12)],
    ['실행 시각', `${formatDateTime(run.startedAtMs)} ~ ${formatDateTime(run.completedAtMs)}`],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">파라미터</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {Object.entries(job.request.parameters).map(([key, value]) => (
            <div key={key} className="flex justify-between">
              <span className="text-muted-foreground">{key}</span>
              <span className="tabular-nums">{String(value)}</span>
            </div>
          ))}
          <div className="flex justify-between">
            <span className="text-muted-foreground">초기 자본</span>
            <span>{formatKrw(job.request.capital.initialCash)}</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">재현 정보</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <span className="shrink-0 text-muted-foreground">{label}</span>
              <span className="truncate text-right font-mono text-xs leading-5">{value}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      {warnings.length > 0 ? (
        <Alert className="lg:col-span-2">
          <AlertTitle>경고·한계</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function BacktestDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { job, run, metrics, isLoading } = useBacktestLive(id);
  const completed = job?.status === 'COMPLETED';
  const { data: series } = useBacktestSeries(id, completed === true);

  const cancelMutation = useMutation({
    mutationFn: () => api(`/backtests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.info('취소를 요청했습니다');
      void queryClient.invalidateQueries({ queryKey: ['backtests', id] });
    },
    onError: () => toast.error('취소할 수 없는 상태입니다'),
  });

  const cloneMutation = useMutation({
    mutationFn: () =>
      api<{ job: { id: string }; warnings?: string[] }>(`/backtests/${id}/clone`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      toast.success('복제되어 대기열에 추가되었습니다');
      // 재기준된 항목은 조용히 넘기지 않는다 — 원본과 결과가 달라질 수 있다
      for (const warning of data.warnings ?? []) toast.warning(warning, { duration: 10_000 });
      void queryClient.invalidateQueries({ queryKey: ['backtests'] });
      void navigate(`/backtests/${data.job.id}`);
    },
    onError: (error: unknown) =>
      toast.error(error instanceof ApiError ? error.message : '복제에 실패했습니다'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api(`/backtests/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('삭제되었습니다');
      void queryClient.invalidateQueries({ queryKey: ['backtests'] });
      void navigate('/backtests');
    },
    onError: () => toast.error('실행 중인 작업은 삭제할 수 없습니다'),
  });

  if (isLoading || !job) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const running = !isTerminal(job.status);
  const progress =
    job.progressBars !== null && job.totalBars !== null && job.totalBars > 0
      ? Math.round((job.progressBars / job.totalBars) * 100)
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{job.strategyId}</h2>
        <StatusBadge status={job.status} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              variant="destructive"
              className="h-11"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending || job.status === 'CANCELLING'}
            >
              <XCircle data-icon="inline-start" />
              취소
            </Button>
          ) : (
            <>
              {/* 실패한 작업은 같은 조건 재실행이 대개 같은 결과다 — 재설정을 앞세운다 */}
              {job.status === 'FAILED' ? (
                <>
                  <Button className="h-11" asChild>
                    <Link to={`/backtests/new?from=${id}`}>
                      <SlidersHorizontal data-icon="inline-start" />
                      재설정 및 복제
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={() => cloneMutation.mutate()}
                    disabled={cloneMutation.isPending}
                  >
                    <Copy data-icon="inline-start" />
                    복제
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    className="h-11"
                    onClick={() => cloneMutation.mutate()}
                    disabled={cloneMutation.isPending}
                  >
                    <Copy data-icon="inline-start" />
                    복제
                  </Button>
                  <Button variant="outline" className="h-11" asChild>
                    <Link to={`/backtests/new?from=${id}`}>
                      <SlidersHorizontal data-icon="inline-start" />
                      재설정 및 복제
                    </Link>
                  </Button>
                </>
              )}
              {completed ? (
                <Button variant="outline" className="h-11" asChild>
                  <a href={`/api/v1/backtests/${id}/export`} download>
                    <Download data-icon="inline-start" />
                    Export
                  </a>
                </Button>
              ) : null}
              <Button variant="ghost" className="h-11" onClick={() => setDeleteOpen(true)}>
                <Trash2 data-icon="inline-start" />
                삭제
              </Button>
            </>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {job.request.universe.symbols.join(', ')} · {job.request.period.from} ~{' '}
        {job.request.period.to} · 생성 {formatDateTime(job.createdAtMs)}
      </p>

      {running ? (
        <Card>
          <CardContent className="space-y-2 py-4">
            <div className="flex items-center justify-between text-sm">
              <span>진행률</span>
              <span className="tabular-nums" aria-live="polite">
                {progress !== null ? `${progress}%` : '준비 중'}
                {job.progressBars !== null && job.totalBars !== null
                  ? ` (${job.progressBars.toLocaleString()} / ${job.totalBars.toLocaleString()} 봉)`
                  : ''}
              </span>
            </div>
            <Progress value={progress ?? 0} aria-label="백테스트 진행률" />
            {job.progressLabel ? (
              <p className="text-xs text-muted-foreground">처리 중: {job.progressLabel}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {job.error ? (
        <Alert variant="destructive">
          <AlertTitle>실패 이유</AlertTitle>
          <AlertDescription>{job.error}</AlertDescription>
        </Alert>
      ) : null}

      {completed && metrics ? (
        <>
          <MetricCards metrics={metrics} />

          {series ? (
            <div className="space-y-4">
              <EquityChart
                points={series.equity}
                summary={`초기 ${formatKrw(metrics.initialCash)} → 최종 ${formatKrw(
                  metrics.finalEquity,
                )} (${formatSignedPct(metrics.totalReturnPct)})${
                  series.totalEquityPoints > series.equity.length
                    ? ` · ${series.totalEquityPoints}포인트를 ${series.equity.length}포인트로 축약 표시`
                    : ''
                }`}
              />
              <DrawdownChart
                points={series.drawdown}
                summary={`최대 낙폭 ${formatSignedPct(metrics.maxDrawdownPct)} · 낙폭 기간 ${formatDuration(
                  metrics.maxDrawdownDurationMs,
                )}`}
              />
              <MonthlyReturnsChart monthly={series.monthly} />

              {series.symbols.length > 1 ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">종목별 성과</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>종목</TableHead>
                          <TableHead className="text-right">거래</TableHead>
                          <TableHead className="text-right">순손익</TableHead>
                          <TableHead className="text-right">승률</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {series.symbols.map((row) => (
                          <TableRow key={row.symbol}>
                            <TableCell>{row.symbol}</TableCell>
                            <TableCell className="text-right">{row.tradeCount}</TableCell>
                            <TableCell
                              className={cn('text-right tabular-nums', pnlClass(row.netPnl))}
                            >
                              {formatSignedKrw(row.netPnl)}
                            </TableCell>
                            <TableCell className="text-right">
                              {row.winRate === null ? '-' : `${row.winRate.toFixed(1)}%`}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          ) : (
            <Skeleton className="h-60 w-full" />
          )}

          <TradesSection jobId={id} symbols={job.request.universe.symbols} />
        </>
      ) : null}

      {run ? <RunMetadataCard run={run} job={job} /> : null}

      {job.status === 'INTERRUPTED' ? (
        <Alert>
          <AlertTitle>중단된 작업</AlertTitle>
          <AlertDescription>
            서버 재시작으로 중단되었습니다. 자동 재실행되지 않으니 복제를 사용하세요.
            <Button variant="link" className="h-auto p-0 pl-2" onClick={() => cloneMutation.mutate()}>
              복제
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div>
        <Button variant="ghost" asChild>
          <Link to="/backtests">← 목록으로</Link>
        </Button>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>백테스트 삭제</DialogTitle>
            <DialogDescription>
              이 작업의 결과·거래 내역이 모두 삭제됩니다. 되돌릴 수 없습니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              취소
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteOpen(false);
                deleteMutation.mutate();
              }}
            >
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
