import { isRefreshRequired, useBacktestRefresh } from "./backtest-refresh-dialog";
import { ResultBenchmarkComparison } from "./result-benchmark-comparison";
import { ExperimentSummary } from "./experiment-summary";
import { BacktestBreadcrumbs } from "./backtest-breadcrumbs";
import {
  ExecutionProgressSummary,
  executionProgressPercent,
} from "./execution-progress-display";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageSizeInput, Pagination } from "@/components/pagination";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BacktestProgressCard } from "./backtest-progress-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { SymbolLabel } from "@/components/symbol-label";
import { useStockNames } from "@/lib/use-stock-names";
import {
  useBacktestLive,
  useBacktestSeries,
  useBacktestTrades,
  useStrategies,
} from "./api";
import { exitReasonLabel } from "./exit-reason";
import { openPositionRows } from "./open-position-rows";
import { periodEndTsMs } from "./stale-days";
import { TradesTable } from "./trades-table";
import { parsePageSize } from "@/lib/page-size";
import { ParamHint } from "./param-hint";
import { extractNumberParams, paramLabel } from "./param-specs";
import {
  formatDateTime,
  formatDuration,
  formatKrw,
  formatNumber,
  formatSignedPct,
  pnlClass,
  sharpeClass,
  timeframeLabel,
} from "@/lib/format";
import {
  DrawdownChart,
  EquityChart,
  MonthlyReturnsChart,
} from "./result-charts";
import { resolveJobTimeframe } from "./job-timeframe";
import { StatusBadge } from "./status-badge";
import { ResultActions } from "./result-actions";
import { ReproductionInfoCard } from "./reproduction-info-card";
import { SharpeBasisInfo } from "./sharpe-basis-info";
import {
  DEFAULT_TRADE_SORT,
  nextTradeSort,
  sortOpenRows,
  tradeSortSummary,
  type TradeSort,
  type TradeSortKey,
} from "./trade-sort";
import { formatUniverseRuleSummary } from "./universe-summary";
import {
  isTerminal,
  type BacktestMetrics,
  type JobSummary,
  type RunMetadata,
} from "./types";
import { costSummary } from "./cost-summary";
import { costProfileLabel, slippageProfileLabel } from "./profile-labels";
import { ResultWarnings } from "./result-warnings";
import {
  selectionMethodLabel,
  universeSourceLabel,
} from "./universe-provenance";
import { UniverseRebalancingSection } from "./universe-rebalancing-section";
import type { ProvenancePin } from "../../../shared/schemas/provenance-pin.js";
import type { UniverseRebalancingEntryDto } from "../../../shared/schemas/universe-rebalancing.js";

const RESULT_PAGE_SIZE = 10;

function MetricCards({
  metrics,
}: {
  metrics: BacktestMetrics;
}) {
  const cost = costSummary(metrics);
  const cards: Array<{
    label: string;
    value: string;
    className: string;
    detail?: string;
    cardClassName?: string;
  }> = [
    {
      label: "누적 수익률",
      value: formatSignedPct(metrics.totalReturnPct),
      className: pnlClass(metrics.totalReturnPct),
    },
    {
      label: "CAGR",
      value: formatSignedPct(metrics.cagrPct),
      className: pnlClass(metrics.cagrPct),
    },
    {
      label: "MDD",
      value: formatSignedPct(metrics.maxDrawdownPct),
      className: pnlClass(metrics.maxDrawdownPct),
    },
    { label: "Sharpe", value: formatNumber(metrics.sharpe), className: sharpeClass(metrics.sharpe) },
    {
      label: "승률 (매도 체결 기준)",
      value: metrics.winRate === null ? "-" : `${metrics.winRate.toFixed(1)}%`,
      className: "",
    },
    {
      label: "매도 체결 수 (부분청산 포함)",
      value: `${metrics.tradeCount}건`,
      className: "",
    },
    {
      label: "총 비용",
      value: cost.totalText,
      className: "",
      detail: cost.detailText,
      cardClassName: "col-span-full",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <Card
          key={card.label}
          className={"cardClassName" in card ? card.cardClassName : undefined}
        >
          <CardContent className="px-4 py-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p
              className={cn(
                "text-lg font-semibold tabular-nums",
                card.className,
              )}
            >
              {card.value}
            </p>
            {"detail" in card && card.detail ? (
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                {card.detail}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
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
  const [symbol, setSymbol] = useState<string>("ALL");
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState(String(RESULT_PAGE_SIZE));
  const [sort, setSort] = useState<TradeSort>(DEFAULT_TRADE_SORT);
  const pageSize = parsePageSize(pageSizeText, RESULT_PAGE_SIZE);
  const { data, isLoading, isPlaceholderData } = useBacktestTrades(
    jobId,
    {
      limit: pageSize,
      offset: page * pageSize,
      sort: sort.key,
      dir: sort.direction,
      ...(symbol !== "ALL" ? { symbol } : {}),
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
      ? sortOpenRows(
          openPositionRows(run?.openPositionsJson ?? null, symbol, periodTo),
          sort,
        )
      : [];
  // 봉 tsMs 규약(UTC 자정)과 맞춰야 한다 — 기간 종료일까지 거래된 정상 종목의 마지막
  // 확인일도 이 값과 같다. KST 자정·23:59:59 같은 다른 규약을 쓰면 반나절 가까이
  // 어긋나 정상 종목에도 "1일 경과" 가 붙는다.
  const periodEndMsForStale = periodEndTsMs(periodTo);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="shrink-0 whitespace-nowrap text-base">거래 내역</CardTitle>
        <Select
          value={symbol}
          onValueChange={(value) => {
            setSymbol(value);
            setPage(0);
          }}
        >
          <SelectTrigger className="h-9 min-w-0 w-56" aria-label="종목 필터">
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
        <div data-pagination-content>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : trades.length === 0 && openRows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            거래가 없습니다.
          </p>
        ) : (
          <TradesTable trades={trades} openRows={openRows} sort={sort} onSort={changeSort}
            nameOf={nameOf} reasonLabel={exitReasonLabel} periodEndMs={periodEndMsForStale} />
        )}
        {trades.length > 0 || openRows.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {tradeSortSummary(sort)}으로 정렬했습니다.
            {openRows.length > 0
              ? " 미청산 행은 첫 페이지 맨 위에 고정되고 같은 축으로 함께 정렬됩니다 — 매도 체결 행과 한 줄로 섞이지는 않습니다."
              : ""}
          </p>
        ) : null}
        {trades.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            매도 체결 행은 부분청산도 각각 한 건으로 집계합니다.
            진입일·보유기간은 해당 포지션의 최초 진입 기준이고, 진입가는 매도
            직전의 이동평균 매수가입니다.
          </p>
        ) : null}
        {openRows.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            미청산 행의 손익은 기간 종료 시점 종가 기준 평가치입니다 (매도 비용
            미반영). 누적 수익률·자산 곡선에는 포함되지만 승률·profit
            factor·매도 체결 수에는 포함되지 않습니다.
          </p>
        ) : null}
        </div>
        <Pagination
          className="mt-3"
          ariaLabel="거래 내역 페이지 이동"
          currentPage={page}
          pending={isPlaceholderData}
          pageCount={pageCount}
          onPageChange={setPage}
        />
      </CardContent>
    </Card>
  );
}

function RunMetadataCard({
  run,
  job,
  strategyName,
  supportsRandomSeed,
  timeframe,
  provenancePin,
  universeRebalancing,
  metrics,
}: {
  run: RunMetadata;
  job: JobSummary;
  strategyName: string | undefined;
  supportsRandomSeed: boolean;
  timeframe: string | null;
  provenancePin: ProvenancePin | null;
  universeRebalancing: readonly UniverseRebalancingEntryDto[];
  metrics: BacktestMetrics | null;
}) {
  const warnings = run.warningsJson
    ? (JSON.parse(run.warningsJson) as string[])
    : [];
  // 라벨·설명은 서버 스키마에서 읽는다 (위저드와 같은 캐시 키).
  // 실패하거나 아직 안 왔으면 원본 키로 표시한다 — 파라미터 값 표시를 막지 않는다.
  const schema = useQuery({
    queryKey: ["strategies", run.strategyId, "schema"],
    queryFn: () =>
      api<{ schema: Record<string, unknown> }>(
        `/strategies/${run.strategyId}/schema`,
      ),
  });
  const specByKey = new Map(
    extractNumberParams(schema.data?.schema).map((spec) => [spec.key, spec]),
  );
  // 요율은 현재 레지스트리에서 찾되 id@version 이 정확히 일치할 때만 붙인다 —
  // 세율이 바뀐 뒤의 레지스트리 값을 구버전 실행에 붙이면 재현 정보가 거짓말한다
  const profiles = useQuery({
    queryKey: ["backtests", "profiles"],
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
        slippageProfiles: Array<{
          id: string;
          version: string;
          bps: number;
          fixed: number;
        }>;
      }>("/backtests/profiles"),
  });
  const feeProfile = profiles.data?.commissionProfiles.find(
    (p) => `${p.id}@${p.version}` === run.feeModelVersion,
  );
  const slippageProfile = profiles.data?.slippageProfiles.find(
    (p) => `${p.id}@${p.version}` === run.slippageModelVersion,
  );
  const rows: Array<[string, string]> = [
    [
      "전략",
      strategyName
        ? `${strategyName} (${run.strategyId} v${run.strategyVersion})`
        : `${run.strategyId} v${run.strategyVersion}`,
    ],
    ["전략 해시", run.strategySourceHash.slice(0, 16)],
    // 잡은 더 이상 datasetId 를 갖지 않는다(스펙 2026-08-05) — 유니버스 출처는
    // provenancePin 에서만 읽는다 (Task 14).
    ["유니버스 출처", universeSourceLabel(provenancePin)],
    ["선정 방식", selectionMethodLabel(provenancePin?.selectionMethod ?? null)],
    ["봉 주기", timeframe ? timeframeLabel(timeframe) : "-"],
    ["유니버스 해시", run.universeHash.slice(0, 16)],
    ["엔진 버전", run.engineVersion],
    [
      "수수료 모델",
      feeProfile
        ? `${run.feeModelVersion} — ${costProfileLabel(feeProfile)}`
        : run.feeModelVersion,
    ],
    [
      "슬리피지 모델",
      slippageProfile
        ? `${run.slippageModelVersion} — ${slippageProfileLabel(slippageProfile)}`
        : run.slippageModelVersion,
    ],
    ...(supportsRandomSeed
      ? [["난수 시드", String(run.randomSeed)] as [string, string]]
      : []),
    ["Git 커밋", run.gitCommitSha.slice(0, 12)],
    [
      "실행 시각",
      `${formatDateTime(run.startedAtMs)} ~ ${formatDateTime(run.completedAtMs)}`,
    ],
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
              <div
                key={key}
                className="flex items-center justify-between gap-2"
              >
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
          <div className="flex justify-between">
            <span className="text-muted-foreground">종목별 최대 비중</span>
            <span>{job.request.risk?.maxPositionWeightPercent == null ? "제한 없음" : `${job.request.risk.maxPositionWeightPercent}%`}</span>
          </div>
        </CardContent>
      </Card>
      <ReproductionInfoCard rows={rows}>
        {metrics ? <SharpeBasisInfo basis={metrics.sharpeBasis} /> : null}
      </ReproductionInfoCard>
      {warnings.length > 0 ? (
        <ResultWarnings warnings={warnings} jobId={job.id} />
      ) : null}
      <UniverseRebalancingSection entries={universeRebalancing} />
    </div>
  );
}

export function BacktestDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const refresh = useBacktestRefresh(id, searchParams.get("refreshJob"));
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const {
    job,
    run,
    metrics,
    provenancePin,
    universeRebalancing,
    isLoading,
    isError,
    error,
  } = useBacktestLive(id);
  const completed = job?.status === "COMPLETED";
  const { data: series } = useBacktestSeries(id, completed === true);

  // `series.symbols` 는 거래 내역에 종목 이름을 붙일 목록이다 — 거래가 0건인 종목은 빠진다.
  const resolvedSymbols = useMemo(() => series?.symbols ?? [], [series]);
  // 거래 내역에 이름을 붙이기 위해 전 종목을 한 번에 조회한다.
  const stockNames = useStockNames(resolvedSymbols);
  const nameOf = (symbol: string): string | null =>
    stockNames.get(symbol)?.name ?? null;

  const cancelMutation = useMutation({
    mutationFn: () => api(`/backtests/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.info("취소를 요청했습니다");
      void queryClient.invalidateQueries({ queryKey: ["backtests", id] });
    },
    onError: () => toast.error("취소할 수 없는 상태입니다"),
  });

  const cloneMutation = useMutation({
    mutationFn: () =>
      api<{ job: { id: string }; warnings?: string[] }>(
        `/backtests/${id}/clone`,
        {
          method: "POST",
        },
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["backtests"] });
      void navigate(`/backtests/${data.job.id}`);
    },
    onError: (error: unknown) => {
      if (isRefreshRequired(error)) {
        refresh.offer({ kind: "CLONE" }, error);
        return;
      }
      toast.error(
        error instanceof ApiError ? error.message : "복제에 실패했습니다",
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api(`/backtests/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("삭제되었습니다");
      void queryClient.invalidateQueries({ queryKey: ["backtests"] });
      void queryClient.invalidateQueries({
        queryKey: ["backtest-clone-batches"],
      });
      void navigate("/backtests");
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
              ? "이미 삭제되었거나 존재하지 않는 백테스트입니다."
              : (error?.message ?? "알 수 없는 오류입니다.")}
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

  const strategy = strategies.data?.strategies.find(
    (s) => s.id === job.strategyId,
  );
  const strategyName = strategy?.name;
  const supportsRandomSeed = strategy?.supportsRandomSeed !== false;
  const resolvedTimeframe = resolveJobTimeframe(job);

  const running = !isTerminal(job.status);
  const barsProgress =
    job.progressBars !== null && job.totalBars !== null && job.totalBars > 0
      ? Math.round((job.progressBars / job.totalBars) * 100)
      : null;
  const activity = job.progress;
  const displayedProgress = activity
    ? executionProgressPercent(activity)
    : barsProgress;

  return (
    <div className="space-y-4">
      <BacktestBreadcrumbs jobId={id} />
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">
          {strategyName ?? job.strategyId}
        </h2>
        <StatusBadge status={job.status} />
        {completed ? <Button variant="outline" onClick={() => void navigate(`/trading?sourceJobId=${encodeURIComponent(id)}`)}>이 설정으로 매매 준비</Button> : null}
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            running ? "ml-auto" : "w-full justify-end sm:ml-auto sm:w-auto",
          )}
        >
          {running ? (
            <Button
              variant="destructive"
              className="h-11"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending || job.status === "CANCELLING"}
            >
              <XCircle data-icon="inline-start" />
              취소
            </Button>
          ) : (
            <ResultActions
              onClone={() => cloneMutation.mutate()}
              clonePending={cloneMutation.isPending}
              searchHref={`/backtests/${encodeURIComponent(id)}/search`}
              reconfigureHref={`/backtests/new?from=${id}`}
              exportHref={completed ? `/api/v1/backtests/${id}/export` : undefined}
              onDelete={() => setDeleteOpen(true)}
            />
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {formatUniverseRuleSummary(job.request.universeRule)} ·{" "}
        {job.request.period.from} ~ {job.request.period.to} · 생성{" "}
        {formatDateTime(job.createdAtMs)}
      </p>

      {running ? (
        <BacktestProgressCard percent={displayedProgress}>
          {activity ? <ExecutionProgressSummary progress={activity} /> : null}
        </BacktestProgressCard>
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
          <ExperimentSummary jobId={id} />

          <ResultBenchmarkComparison key={id} jobId={id} period={job.request.period} strategy={series?.equity ?? []} initialCash={metrics.initialCash} />

          {series ? (
            <div className="space-y-4">
              <EquityChart
                points={series.equity}
                summary={`초기 ${formatKrw(metrics.initialCash)} → 최종 ${formatKrw(
                  metrics.finalEquity,
                )} (${formatSignedPct(metrics.totalReturnPct)})${
                  series.totalEquityPoints > series.equity.length
                    ? ` · ${series.totalEquityPoints}포인트를 ${series.equity.length}포인트로 축약 표시`
                    : ""
                }`}
              />
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
            supportsRandomSeed={
              supportsRandomSeed || strategy?.version !== run.strategyVersion
            }
            timeframe={resolvedTimeframe}
            provenancePin={provenancePin}
            universeRebalancing={universeRebalancing}
            metrics={metrics}
          />
        </>
      ) : null}

      {job.status === "INTERRUPTED" ? (
        <Alert>
          <AlertTitle>중단된 작업</AlertTitle>
          <AlertDescription>
            서버 재시작으로 중단되었습니다. 자동 재실행되지 않으니 복제를
            사용하세요.
            <Button
              variant="link"
              className="h-auto p-0 pl-2"
              onClick={() => cloneMutation.mutate()}
            >
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

      {refresh.modal}
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

    </div>
  );
}
