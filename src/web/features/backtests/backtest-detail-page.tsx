import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Copy,
  Download,
  SlidersHorizontal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { PageSizeInput, Pagination } from '@/components/pagination';
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
import { SymbolLabel } from '@/components/symbol-label';
import { useStockNames } from '@/lib/use-stock-names';
import { useBacktestLive, useBacktestSeries, useBacktestTrades } from './api';
import { exitReasonLabel } from './exit-reason';
import { openPositionRows } from './open-position-rows';
import { parsePageSize } from '@/lib/page-size';
import { pageWindow } from '@/lib/pagination';
import { ParamHint } from './param-hint';
import { extractNumberParams, paramLabel } from './param-specs';
import {
  formatDateTime,
  formatDuration,
  formatKrw,
  formatNumber,
  formatSignedKrw,
  formatSignedPct,
  pnlClass,
  timeframeLabel,
} from '@/lib/format';
import { DrawdownChart, EquityChart, MonthlyReturnsChart } from './result-charts';
import { resolveJobTimeframe } from './job-timeframe';
import { StatusBadge } from './status-badge';
import {
  ariaSortValue,
  DEFAULT_TRADE_SORT,
  nextTradeSort,
  sortOpenRows,
  TRADE_SORT_LABELS,
  tradeSortHint,
  tradeSortSummary,
  type TradeSort,
  type TradeSortKey,
} from './trade-sort';
import { formatUniverseRuleSummary } from './universe-summary';
import { isTerminal, type BacktestMetrics, type JobSummary, type RunMetadata } from './types';
import { costSummary } from './cost-summary';
import { costProfileLabel, slippageProfileLabel } from './profile-labels';
import { groupWarnings } from './warning-groups';
import { selectionMethodLabel, universeSourceLabel } from './universe-provenance';
import type { ProvenancePin } from '../../../shared/schemas/provenance-pin.js';

function MetricCards({ metrics }: { metrics: BacktestMetrics }) {
  const cost = costSummary(metrics);
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
      label: '승률 (청산 기준)',
      value: metrics.winRate === null ? '-' : `${metrics.winRate.toFixed(1)}%`,
      className: '',
    },
    { label: '청산 거래 수', value: `${metrics.tradeCount}건`, className: '' },
    {
      label: '총 비용',
      value: cost.totalText,
      className: '',
      detail: cost.detailText,
      cardClassName: 'col-span-full',
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <Card key={card.label} className={'cardClassName' in card ? card.cardClassName : undefined}>
          <CardContent className="px-4 py-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className={cn('text-lg font-semibold tabular-nums', card.className)}>{card.value}</p>
            {'detail' in card && card.detail ? (
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">{card.detail}</p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * 정렬 가능한 열 머리글.
 *
 * 이름은 버튼의 보이는 글자 그대로 두고(aria-label 로 덮지 않는다) 지금 순서는
 * `<th aria-sort>` 가 알린다 — 스크린리더가 열 이름과 정렬 상태를 따로 읽는다.
 * 누르면 어떻게 되는지는 `title` 에 적는다.
 */
function SortableHead({
  sortKey,
  sort,
  onSort,
  align,
}: {
  sortKey: TradeSortKey;
  sort: TradeSort;
  onSort: (key: TradeSortKey) => void;
  align?: 'right';
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead
      aria-sort={ariaSortValue(sort, sortKey)}
      className={align === 'right' ? 'text-right' : undefined}
    >
      <Button
        variant="ghost"
        size="xs"
        // -mx-2 로 버튼 자기 여백을 상쇄해 글자가 아래 셀과 같은 줄에 선다
        className="-mx-2 font-medium"
        title={tradeSortHint(sort, sortKey)}
        onClick={() => onSort(sortKey)}
      >
        {TRADE_SORT_LABELS[sortKey]}
        {active ? (
          sort.direction === 'ASC' ? (
            <ArrowUp />
          ) : (
            <ArrowDown />
          )
        ) : (
          // 고르지 않은 축도 누를 수 있다는 것이 보여야 한다 — 아이콘 없이 두면
          // 활성 열만 정렬되는 줄로 읽힌다
          <ChevronsUpDown className="opacity-40" />
        )}
      </Button>
    </TableHead>
  );
}

function TradesSection({
  jobId,
  symbols,
  run,
  periodTo,
  nameOf,
}: {
  jobId: string;
  symbols: string[];
  run: RunMetadata | null;
  periodTo: string;
  nameOf: (symbol: string) => string | null;
}) {
  const [symbol, setSymbol] = useState<string>('ALL');
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState('10');
  const [sort, setSort] = useState<TradeSort>(DEFAULT_TRADE_SORT);
  const pageSize = parsePageSize(pageSizeText, 10);
  const { data, isLoading } = useBacktestTrades(
    jobId,
    {
      limit: pageSize,
      offset: page * pageSize,
      sort: sort.key,
      dir: sort.direction,
      ...(symbol !== 'ALL' ? { symbol } : {}),
    },
    true,
  );
  const trades = data?.trades ?? [];
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  // 정렬을 바꾸면 1페이지로 돌아간다 — 「순손익 높은 순」을 골랐는데 3페이지에 남아
  // 있으면 상위 거래를 건너뛴 채 21번째부터 보게 된다 (종목 필터와 같은 처리)
  const changeSort = (key: TradeSortKey) => {
    setSort((current) => nextTradeSort(current, key));
    setPage(0);
  };
  const openRows =
    page === 0
      ? sortOpenRows(openPositionRows(run?.openPositionsJson ?? null, symbol, periodTo), sort)
      : [];

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
          <SelectTrigger className="h-9 w-56" aria-label="종목 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 종목</SelectItem>
            {symbols.map((s) => (
              <SelectItem key={s} value={s}>
                <SymbolLabel symbol={s} name={nameOf(s)} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <div className="mb-2 flex justify-end">
          <PageSizeInput
            value={pageSizeText}
            label="거래 내역 페이지당 표시 수"
            unit="건"
            onChange={(nextValue) => {
              setPageSizeText(nextValue);
              setPage(0);
            }}
          />
        </div>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : trades.length === 0 && openRows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">거래가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {/* 종목·사유는 정렬 축이 아니다 — 종목은 위 필터가 맡고, 사유는
                      코드 문자열 순서가 사람에게 뜻이 없다. 누를 수 있게 두면 골랐는데
                      순서가 그대로인 상태가 된다 (D-027·D-038 과 같은 방향) */}
                  <TableHead>종목</TableHead>
                  <SortableHead sortKey="QUANTITY" sort={sort} onSort={changeSort} align="right" />
                  <SortableHead sortKey="ENTRY_TS" sort={sort} onSort={changeSort} />
                  <SortableHead sortKey="EXIT_TS" sort={sort} onSort={changeSort} />
                  <SortableHead sortKey="NET_PNL" sort={sort} onSort={changeSort} align="right" />
                  <SortableHead
                    sortKey="RETURN_PCT"
                    sort={sort}
                    onSort={changeSort}
                    align="right"
                  />
                  <SortableHead sortKey="HOLDING_TIME" sort={sort} onSort={changeSort} />
                  <TableHead>사유</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openRows.map((row) => (
                  <TableRow key={`open-${row.symbol}`} className="bg-muted/40">
                    <TableCell className="font-medium">
                      <SymbolLabel symbol={row.symbol} name={nameOf(row.symbol)} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.quantity}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(row.entryTsMs)}
                      <br />
                      <span className="text-muted-foreground">{formatKrw(row.entryPrice)}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      <Badge variant="outline">미청산</Badge>
                      <br />
                      <span className="text-muted-foreground">{formatKrw(row.lastPrice)}</span>
                    </TableCell>
                    <TableCell
                      className={cn('text-right tabular-nums', pnlClass(row.unrealizedPnl))}
                    >
                      {formatSignedKrw(row.unrealizedPnl)}
                    </TableCell>
                    <TableCell
                      className={cn('text-right tabular-nums', pnlClass(row.returnPct))}
                    >
                      {formatSignedPct(row.returnPct)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDuration(row.holdingTimeMs)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">미청산</TableCell>
                  </TableRow>
                ))}
                {trades.map((trade) => (
                  <TableRow key={trade.id}>
                    <TableCell className="font-medium">
                      <SymbolLabel symbol={trade.symbol} name={nameOf(trade.symbol)} />
                    </TableCell>
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
                      {exitReasonLabel(trade.exitReason)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {trades.length > 0 || openRows.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {tradeSortSummary(sort)}으로 정렬했습니다.
            {openRows.length > 0
              ? ' 미청산 행은 첫 페이지 맨 위에 고정되고 같은 축으로 함께 정렬됩니다 — 청산 거래와 한 줄로 섞이지는 않습니다.'
              : ''}
          </p>
        ) : null}
        {openRows.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            미청산 행의 손익은 기간 종료 시점 종가 기준 평가치입니다 (매도 비용 미반영). 누적
            수익률·자산 곡선에는 포함되지만 승률·profit factor·거래 수에는 포함되지 않습니다.
          </p>
        ) : null}
        <Pagination
          className="mt-3"
          ariaLabel="거래 내역 페이지 이동"
          currentPage={page}
          pageCount={pageCount}
          onPageChange={setPage}
        />
      </CardContent>
    </Card>
  );
}

function WarningsSection({ warnings }: { warnings: string[] }) {
  const [grouped, setGrouped] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState('20');
  const pageSize = parsePageSize(pageSizeText, 20);

  const rows = grouped ? groupWarnings(warnings).map((group) => group.label) : warnings;
  const { pageCount, currentPage, from, to } = pageWindow(rows.length, pageSize, page);
  const visible = rows.slice(from, to);

  return (
    <Alert className="lg:col-span-2">
      <AlertTitle>경고·한계</AlertTitle>
      <AlertDescription>
        <div className="mb-2 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={grouped}
              onCheckedChange={(checked) => {
                setGrouped(checked === true);
                setPage(0);
              }}
            />
            묶어 보기
          </label>
          <PageSizeInput
            value={pageSizeText}
            label="경고 목록 페이지당 표시 수"
            unit="건"
            onChange={(nextValue) => {
              setPageSizeText(nextValue);
              setPage(0);
            }}
          />
        </div>
        <ul className="list-disc space-y-1 pl-4">
          {visible.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
        <Pagination
          className="mt-3"
          ariaLabel="경고 목록 페이지 이동"
          currentPage={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
        />
      </AlertDescription>
    </Alert>
  );
}

function RunMetadataCard({
  run,
  job,
  strategyName,
  timeframe,
  provenancePin,
}: {
  run: RunMetadata;
  job: JobSummary;
  strategyName: string | undefined;
  timeframe: string | null;
  provenancePin: ProvenancePin | null;
}) {
  const warnings = run.warningsJson ? (JSON.parse(run.warningsJson) as string[]) : [];
  // 라벨·설명은 서버 스키마에서 읽는다 (위저드와 같은 캐시 키).
  // 실패하거나 아직 안 왔으면 원본 키로 표시한다 — 파라미터 값 표시를 막지 않는다.
  const schema = useQuery({
    queryKey: ['strategies', run.strategyId, 'schema'],
    queryFn: () => api<{ schema: Record<string, unknown> }>(`/strategies/${run.strategyId}/schema`),
  });
  const specByKey = new Map(
    extractNumberParams(schema.data?.schema).map((spec) => [spec.key, spec]),
  );
  // 요율은 현재 레지스트리에서 찾되 id@version 이 정확히 일치할 때만 붙인다 —
  // 세율이 바뀐 뒤의 레지스트리 값을 구버전 실행에 붙이면 재현 정보가 거짓말한다
  const profiles = useQuery({
    queryKey: ['backtests', 'profiles'],
    queryFn: () =>
      api<{
        commissionProfiles: Array<{
          id: string;
          version: string;
          buyCommissionRate: number;
          sellCommissionRate: number;
          sellTaxRate: number;
        }>;
        slippageProfiles: Array<{ id: string; version: string; bps: number; fixed: number }>;
      }>('/backtests/profiles'),
  });
  const feeProfile = profiles.data?.commissionProfiles.find(
    (p) => `${p.id}@${p.version}` === run.feeModelVersion,
  );
  const slippageProfile = profiles.data?.slippageProfiles.find(
    (p) => `${p.id}@${p.version}` === run.slippageModelVersion,
  );
  const rows: Array<[string, string]> = [
    [
      '전략',
      strategyName
        ? `${strategyName} (${run.strategyId} v${run.strategyVersion})`
        : `${run.strategyId} v${run.strategyVersion}`,
    ],
    ['전략 해시', run.strategySourceHash.slice(0, 16)],
    // 잡은 더 이상 datasetId 를 갖지 않는다(스펙 2026-08-05) — 유니버스 출처는
    // provenancePin 에서만 읽는다 (Task 14).
    ['유니버스 출처', universeSourceLabel(provenancePin)],
    ['선정 방식', selectionMethodLabel(provenancePin?.selectionMethod ?? null)],
    ['봉 주기', timeframe ? timeframeLabel(timeframe) : '-'],
    ['유니버스 해시', run.universeHash.slice(0, 16)],
    ['엔진 버전', run.engineVersion],
    [
      '수수료 모델',
      feeProfile ? `${run.feeModelVersion} — ${costProfileLabel(feeProfile)}` : run.feeModelVersion,
    ],
    [
      '슬리피지 모델',
      slippageProfile
        ? `${run.slippageModelVersion} — ${slippageProfileLabel(slippageProfile)}`
        : run.slippageModelVersion,
    ],
    ['난수 시드', String(run.randomSeed)],
    ['Git 커밋', run.gitCommitSha.slice(0, 12)],
    ['실행 시각', `${formatDateTime(run.startedAtMs)} ~ ${formatDateTime(run.completedAtMs)}`],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">파라미터</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {Object.entries(job.request.parameters).map(([key, value]) => {
            const spec = specByKey.get(key);
            return (
              <div key={key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-muted-foreground">
                  {spec ? paramLabel(spec) : key}
                  {spec ? <ParamHint spec={spec} /> : null}
                </span>
                <span className="tabular-nums">{String(value)}</span>
              </div>
            );
          })}
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
              {/* 잘라내지 않고 접는다 — 재현 정보는 값의 끝까지가 근거다. 해시가 「a1b2…」
                  로 잘리면 다른 실행과 같은지 눈으로 비교할 수 없고, 비용 모델 요율은
                  잘리는 자리가 하필 숫자다. wrap-anywhere 를 쓰는 이유: 해시·id·
                  `id@version` 은 공백이 없어 break-words 로는 한 줄을 넘겨도 쪼개지지
                  않는다 (min-content 가 문자열 전체다). */}
              <span className="text-right font-mono text-xs leading-5 wrap-anywhere">{value}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      {warnings.length > 0 ? <WarningsSection warnings={warnings} /> : null}
    </div>
  );
}

export function BacktestDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { job, run, metrics, provenancePin, isLoading } = useBacktestLive(id);
  const completed = job?.status === 'COMPLETED';
  const { data: series } = useBacktestSeries(id, completed === true);

  /**
   * 실행된 종목 목록 — `job.request` 에는 더 이상 종목 목록이 없다(스펙 2026-08-05,
   * `universeRule` 만 있다). 실제 구성은 서버가 제출 시점에 재구성해 잡에 pin 하지만
   * 이 화면은 그 pin 원문을 내려받지 않으므로, 대신 이미 조회하는 `series.symbols`
   * (실거래가 있었던 종목)로 표시용 목록을 삼는다 — 거래가 0건인 종목은 빠진다.
   * 개념을 온전히 다시 세우는 작업은 T6 로 미룬다.
   */
  const resolvedSymbols = useMemo(
    () => series?.symbols.map((s) => s.symbol) ?? [],
    [series],
  );
  // 전 종목을 한 번에 조회한다 — 거래 내역과 종목별 성과가 같은 Map 을 쓴다.
  const stockNames = useStockNames(resolvedSymbols);
  const nameOf = (symbol: string): string | null => stockNames.get(symbol)?.name ?? null;

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

  const strategies = useQuery({
    queryKey: ['strategies'],
    queryFn: () =>
      api<{ strategies: Array<{ id: string; name: string; description: string }> }>('/strategies'),
  });

  if (isLoading || !job) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const strategyName = strategies.data?.strategies.find((s) => s.id === job.strategyId)?.name;
  const resolvedTimeframe = resolveJobTimeframe(job);

  const running = !isTerminal(job.status);
  const progress =
    job.progressBars !== null && job.totalBars !== null && job.totalBars > 0
      ? Math.round((job.progressBars / job.totalBars) * 100)
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{strategyName ?? job.strategyId}</h2>
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
        {formatUniverseRuleSummary(job.request.universeRule)} · {job.request.period.from} ~{' '}
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
                            <TableCell>
                              <SymbolLabel symbol={row.symbol} name={nameOf(row.symbol)} />
                            </TableCell>
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

          <TradesSection
            jobId={id}
            symbols={resolvedSymbols}
            run={run ?? null}
            periodTo={job.request.period.to}
            nameOf={nameOf}
          />
        </>
      ) : null}

      {run ? (
        <>
          <RunMetadataCard
            run={run}
            job={job}
            strategyName={strategyName}
            timeframe={resolvedTimeframe}
            provenancePin={provenancePin}
          />
        </>
      ) : null}

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
