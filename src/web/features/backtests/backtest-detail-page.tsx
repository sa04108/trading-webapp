import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Copy,
  Dices,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { useBacktestLive, useBacktestSeries, useBacktestTrades, useStrategies } from './api';
import { exitReasonLabel } from './exit-reason';
import { openPositionRows } from './open-position-rows';
import { periodEndTsMs, staleDays } from './stale-days';
import { parsePageSize } from '@/lib/page-size';
import { pageWindow } from '@/lib/pagination';
import { ParamHint } from './param-hint';
import { extractNumberParams, paramLabel } from './param-specs';
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatKrw,
  formatNumber,
  formatSignedKrw,
  formatSignedPct,
  pnlClass,
  timeframeLabel,
} from '@/lib/format';
import {
  BenchmarkComparisonChart,
  DrawdownChart,
  EquityChart,
  MonthlyReturnsChart,
} from './result-charts';
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
import {
  isTerminal,
  type BacktestMetrics,
  type BenchmarkResult,
  type JobSummary,
  type RunMetadata,
} from './types';
import { costSummary } from './cost-summary';
import { costProfileLabel, slippageProfileLabel } from './profile-labels';
import { groupWarnings } from './warning-groups';
import { selectionMethodLabel, universeSourceLabel } from './universe-provenance';
import { UniverseRebalancingSection } from './universe-rebalancing-section';
import type { ProvenancePin } from '../../../shared/schemas/provenance-pin.js';
import type { UniverseRebalancingEntryDto } from '../../../shared/schemas/universe-rebalancing.js';

const RESULT_PAGE_SIZE = 10;

function MetricCards({ metrics, benchmark }: { metrics: BacktestMetrics; benchmark: BenchmarkResult | null }) {
  const cost = costSummary(metrics);
  const cards: Array<{
    label: string;
    value: string;
    className: string;
    detail?: string;
    cardClassName?: string;
  }> = [
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
      label: '승률 (매도 체결 기준)',
      value: metrics.winRate === null ? '-' : `${metrics.winRate.toFixed(1)}%`,
      className: '',
    },
    { label: '매도 체결 수 (부분청산 포함)', value: `${metrics.tradeCount}건`, className: '' },
    {
      label: '총 비용',
      value: cost.totalText,
      className: '',
      detail: cost.detailText,
      cardClassName: 'col-span-full',
    },
  ];
  if (benchmark?.available && benchmark.totalReturnPct !== null && benchmark.excessReturnPct !== null) {
    cards.splice(1, 0,
      {
        label: `${benchmark.name} 수익률`,
        value: formatSignedPct(benchmark.totalReturnPct),
        className: pnlClass(benchmark.totalReturnPct),
      },
      {
        label: '초과 수익률',
        value: formatSignedPct(benchmark.excessReturnPct),
        className: pnlClass(benchmark.excessReturnPct),
      },
    );
  }
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
  const [pageSizeText, setPageSizeText] = useState(String(RESULT_PAGE_SIZE));
  const [sort, setSort] = useState<TradeSort>(DEFAULT_TRADE_SORT);
  const pageSize = parsePageSize(pageSizeText, RESULT_PAGE_SIZE);
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
  // 봉 tsMs 규약(UTC 자정)과 맞춰야 한다 — 기간 종료일까지 거래된 정상 종목의 마지막
  // 확인일도 이 값과 같다. KST 자정·23:59:59 같은 다른 규약을 쓰면 반나절 가까이
  // 어긋나 정상 종목에도 "1일 경과" 가 붙는다.
  const periodEndMsForStale = periodEndTsMs(periodTo);

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
                  {/* 미청산 행에만 값이 있다 — 매도 체결 행은 이미 매도일이 있어 별도로
                      "확인일" 을 말할 필요가 없다. 정렬 축으로 두지 않는 이유는 사유와 같다 */}
                  <TableHead>마지막 확인일</TableHead>
                  <TableHead>사유</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openRows.map((row) => {
                  const stale = staleDays(row.lastPriceTsMs, periodEndMsForStale);
                  return (
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
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(row.lastPriceTsMs)}
                        {stale > 0 ? ` (${stale}일 경과)` : ''}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">미청산</TableCell>
                    </TableRow>
                  );
                })}
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
                    {/* 매도 체결 행에는 "마지막 확인일" 개념이 없다 — 매도일이 그 역할이다 */}
                    <TableCell className="text-xs text-muted-foreground">-</TableCell>
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
              ? ' 미청산 행은 첫 페이지 맨 위에 고정되고 같은 축으로 함께 정렬됩니다 — 매도 체결 행과 한 줄로 섞이지는 않습니다.'
              : ''}
          </p>
        ) : null}
        {trades.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            매도 체결 행은 부분청산도 각각 한 건으로 집계합니다. 진입일·보유기간은
            해당 포지션의 최초 진입 기준이고, 진입가는 매도 직전의 이동평균 매수가입니다.
          </p>
        ) : null}
        {openRows.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            미청산 행의 손익은 기간 종료 시점 종가 기준 평가치입니다 (매도 비용 미반영). 누적
            수익률·자산 곡선에는 포함되지만 승률·profit factor·매도 체결 수에는 포함되지 않습니다.
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
  universeRebalancing,
}: {
  run: RunMetadata;
  job: JobSummary;
  strategyName: string | undefined;
  timeframe: string | null;
  provenancePin: ProvenancePin | null;
  universeRebalancing: readonly UniverseRebalancingEntryDto[];
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
          sellTaxRateSchedule?: Array<{ fromTsMs: number; rate: number }>;
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
      <UniverseRebalancingSection entries={universeRebalancing} />
    </div>
  );
}

export function BacktestDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [seedCloneOpen, setSeedCloneOpen] = useState(false);
  const [seedCloneCount, setSeedCloneCount] = useState('10');

  const {
    job,
    run,
    metrics,
    benchmark,
    provenancePin,
    universeRebalancing,
    isLoading,
    isError,
    error,
  } = useBacktestLive(id);
  const completed = job?.status === 'COMPLETED';
  const { data: series } = useBacktestSeries(id, completed === true);

  // `series.symbols` 는 거래 내역에 종목 이름을 붙일 목록이다 — 거래가 0건인 종목은 빠진다.
  const resolvedSymbols = useMemo(() => series?.symbols ?? [], [series]);
  // 거래 내역에 이름을 붙이기 위해 전 종목을 한 번에 조회한다.
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
    onError: (error: unknown) => {
      if (
        error instanceof ApiError
        && (error.message === 'PREPARATION_REQUIRED' || error.message === 'PREVIEW_REQUIRED')
      ) {
        toast.error('현재 데이터를 다시 준비해야 합니다. 재설정 및 복제에서 미리보기를 완료하세요.');
        return;
      }
      toast.error(error instanceof ApiError ? error.message : '복제에 실패했습니다');
    },
  });

  const seedCloneMutation = useMutation({
    mutationFn: (count: number) =>
      api<{ batch: { id: string }; warnings?: string[] }>(
        `/backtests/${id}/clone-random-seeds`,
        { method: 'POST', body: JSON.stringify({ count }) },
      ),
    onSuccess: (data) => {
      setSeedCloneOpen(false);
      toast.success('새 난수 시드 실험을 시작했습니다');
      for (const warning of data.warnings ?? []) toast.warning(warning, { duration: 10_000 });
      void queryClient.invalidateQueries({ queryKey: ['backtests'] });
      void queryClient.invalidateQueries({ queryKey: ['backtest-clone-batches'] });
      void navigate(`/backtests/batches/${data.batch.id}`);
    },
    onError: (error: unknown) => {
      if (
        error instanceof ApiError
        && (error.message === 'PREPARATION_REQUIRED' || error.message === 'PREVIEW_REQUIRED')
      ) {
        toast.error('현재 데이터를 다시 준비해야 합니다. 재설정 및 복제에서 미리보기를 완료하세요.');
        return;
      }
      toast.error(error instanceof ApiError ? error.message : '새 난수 복제에 실패했습니다');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api(`/backtests/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('삭제되었습니다');
      void queryClient.invalidateQueries({ queryKey: ['backtests'] });
      void queryClient.invalidateQueries({ queryKey: ['backtest-clone-batches'] });
      void navigate('/backtests');
    },
    onError: (error) => toast.error(error.message),
  });

  const strategies = useStrategies();

  // 조회가 실패하면 결과가 없다고 말한다 — 알림에서 넘어오면 그 사이 삭제된 잡일 수
  // 있는데, 스켈레톤만 두면 영영 로딩 중으로 보인다
  if (isError) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertTitle>결과를 불러올 수 없습니다</AlertTitle>
          <AlertDescription>
            {notFound
              ? '이미 삭제되었거나 존재하지 않는 백테스트입니다.'
              : (error?.message ?? '알 수 없는 오류입니다.')}
          </AlertDescription>
        </Alert>
        <Button variant="ghost" asChild>
          <Link to="/backtests">← 목록으로</Link>
        </Button>
      </div>
    );
  }

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
        <div
          className={cn(
            'flex flex-wrap items-center gap-2',
            running ? 'ml-auto' : 'w-full justify-end sm:ml-auto sm:w-auto',
          )}
        >
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
              <div
                className="grid w-full grid-cols-2 overflow-hidden rounded-lg border border-input sm:w-auto sm:auto-cols-max sm:grid-flow-col sm:grid-cols-none"
                role="group"
                aria-label="백테스트 복제"
              >
                <Button
                  className="h-11 min-w-0 rounded-none border-0 focus-visible:z-10 focus-visible:ring-inset"
                  onClick={() => cloneMutation.mutate()}
                  disabled={cloneMutation.isPending}
                >
                  <Copy data-icon="inline-start" />
                  그대로 복제
                </Button>
                {job.cloneBatchId === null ? (
                  <Button
                    variant="outline"
                    className="h-11 min-w-0 rounded-none border-0 border-l border-input focus-visible:z-10 focus-visible:ring-inset"
                    onClick={() => setSeedCloneOpen(true)}
                  >
                    <Dices data-icon="inline-start" />
                    새 난수로 복제
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  className={cn(
                    'h-11 min-w-0 rounded-none border-0 border-input focus-visible:z-10 focus-visible:ring-inset',
                    job.cloneBatchId === null
                      ? 'col-span-2 border-t sm:col-span-1 sm:border-l sm:border-t-0'
                      : 'border-l',
                  )}
                  asChild
                >
                  <Link to={`/backtests/new?from=${id}`}>
                    <SlidersHorizontal data-icon="inline-start" />
                    재설정 및 복제
                  </Link>
                </Button>
              </div>
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
          <MetricCards metrics={metrics} benchmark={benchmark} />

          {benchmark && !benchmark.available ? (
            <Alert>
              <AlertTitle>{benchmark.name} 비교 사용 불가</AlertTitle>
              <AlertDescription>{benchmark.unavailableReason}</AlertDescription>
            </Alert>
          ) : null}

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
              {benchmark?.available && benchmark.totalReturnPct !== null && benchmark.excessReturnPct !== null ? (
                <BenchmarkComparisonChart
                  strategy={series.equity}
                  benchmark={series.benchmark}
                  initialCash={metrics.initialCash}
                  benchmarkName={benchmark.name}
                  summary={`${benchmark.name} ${formatSignedPct(benchmark.totalReturnPct)} · 초과 수익률 ${formatSignedPct(benchmark.excessReturnPct)} · 시작값 100 기준`}
                />
              ) : null}
              <DrawdownChart
                points={series.drawdown}
                summary={`최대 낙폭 ${formatSignedPct(metrics.maxDrawdownPct)} · 낙폭 기간 ${formatDuration(
                  metrics.maxDrawdownDurationMs,
                )}`}
              />
              <MonthlyReturnsChart monthly={series.monthly} />

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
            universeRebalancing={universeRebalancing}
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
              이 작업의 결과·거래 내역과 이 작업에서 만든 난수 시드 실험이 모두
              삭제됩니다. 되돌릴 수 없습니다.
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

      <Dialog open={seedCloneOpen} onOpenChange={setSeedCloneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 난수로 일괄 복제</DialogTitle>
            <DialogDescription>
              다른 설정과 원본 유니버스는 그대로 유지하고 각 실행에 서로 다른 32비트
              난수 시드를 부여합니다. 시드가 달라도 난수가 쓰이는 상황이 없으면 결과가
              같을 수 있습니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="seed-clone-count">실행 개수</Label>
            <Input
              id="seed-clone-count"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={seedCloneCount}
              onChange={(event) => setSeedCloneCount(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              최대 100개이며 기존 대기열에 여유가 생길 때마다 순차 실행됩니다.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSeedCloneOpen(false)}>취소</Button>
            <Button
              disabled={
                seedCloneMutation.isPending ||
                !Number.isInteger(Number(seedCloneCount)) ||
                Number(seedCloneCount) < 1 ||
                Number(seedCloneCount) > 100
              }
              onClick={() => seedCloneMutation.mutate(Number(seedCloneCount))}
            >
              {seedCloneMutation.isPending ? '생성 중…' : `${seedCloneCount || '0'}개 생성 및 실행`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
