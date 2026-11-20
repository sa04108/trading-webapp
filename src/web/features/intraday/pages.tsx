import { HistoryResultCard, HistoryResultDetails } from "../backtests/history-result-card";
import { Badge } from "@/components/ui/badge";
import { BacktestDeleteDialog } from "../backtests/backtest-delete-dialog";
import { IntradayChartView } from "./intraday-chart";
export { IntradayDataPage } from "./intraday-data-page";
import { useHistoryQueries } from "../backtests/use-history-queries";
import { useHistoryEditing } from "../backtests/history-editing";
import { BacktestBreadcrumbs } from "../backtests/backtest-breadcrumbs";
import { ResultActions } from "../backtests/result-actions";
import { IntradayReproductionInfo } from "./intraday-reproduction-info";
import { ExperimentSummary } from "../backtests/experiment-summary";
import { useBacktestHistoryExtras } from "../backtests/experiment-api";
import { EquityChart } from "../backtests/result-charts";
import { IntradayTradesSection } from "./intraday-trades-section";
import { summarizeIntradayTrades } from "@shared/intraday-trades";
import { downsampleLttb } from "@shared/downsample";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { BacktestHeader, NewBacktestButton } from "../backtests/backtest-header";
import { BacktestProgressCard } from "../backtests/backtest-progress-card";
import {
  HistoryPager,
  HistoryEditActions,
  HistoryStrategyGroup,
  HistoryToolbar,
  historyPeriod,
  useHistoryControls,
} from "../backtests/history-controls";
import type { HistoryGroup } from "../../../shared/schemas/backtest-history";
import { formatSignedPct, formatSignedKrw, formatKrw, formatNumber, formatDuration, pnlClass, sharpeClass } from "@/lib/format";
import { useStockNames } from "@/lib/use-stock-names";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  INTRADAY_STRATEGIES,
  INTRADAY_TRADE_CONTROL_FIELDS,
  intradayRunRequestSchema,
  getIntradayStrategy,
  type IntradayStrategyId,
} from "../../../shared/schemas/intraday-strategies";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import { HistoryLayout, HistoryMetricCells, HistoryTable } from "../backtests/history-table";
import { useHistoryTablePreferences } from "../backtests/history-table-preferences";
import { Skeleton } from "@/components/ui/skeleton";
import { isUnavailableApiError, api, postJson } from "@/lib/api-client";
import {
  intradayDate,
  intradayFirstBacktestDate,
  intradayRetentionDate,
  type IntradayRequest,
  type IntradayRun,
  type IntradayRunSummary,
  type IntradaySignal,
  type IntradayFill,
  type IntradayTimeframe,
} from "../../../shared/schemas/intraday";

const active = (status: string) =>
  ["QUEUED", "PREPARING", "RUNNING"].includes(status);
const statusLabel: Record<string, string> = {
  QUEUED: "대기",
  PREPARING: "데이터 준비",
  RUNNING: "실행 중",
  COMPLETED: "",
  FAILED: "실패",
  CANCELLED: "취소됨",
};
function IntradayStatusBadge({ status }: { status: string }) {
  if (status === "COMPLETED") return null;
  return <Badge variant={status === "FAILED" ? "destructive" : active(status) ? "secondary" : "outline"}>{statusLabel[status]}</Badge>;
}
const time = (ms: number | null) =>
  ms === null
    ? "없음"
    : new Date(ms).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const money = (n: number) =>
  n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const message = (error: unknown) =>
  error instanceof Error ? error.message : "요청에 실패했습니다.";
const yesterday = () => intradayDate(Date.now() - 86_400_000);
const defaults = (
  strategyId: IntradayStrategyId = "intraday-orb",
): IntradayRequest =>
  ({
    mode: "intraday",
    strategyId,
    symbol: "",
    period: { from: intradayFirstBacktestDate(), to: yesterday() },
    timeframe: getIntradayStrategy(strategyId).defaultTimeframe,
    initialCash: 10_000_000,
    parameters: { ...getIntradayStrategy(strategyId).defaults },
    execution: {
      holdingPolicy: "DAY_ONLY",
      commissionBps: 1.5,
      taxBps: 20,
      slippageBps: 5,
      latencyMs: 1000,
      orderExpiryMinutes: 3,
      maxParticipationPct: 1,
    },
  }) as IntradayRequest;
function ErrorAlert({ error }: { error: unknown }) {
  return error ? (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{message(error)}</AlertDescription>
    </Alert>
  ) : null;
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      {children}
    </label>
  );
}
function SymbolSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const symbols = useQuery({
    queryKey: ["intraday-symbols", query],
    queryFn: () =>
      api<{ symbols: { symbol: string; name: string }[] }>(
        `/intraday/symbols?${new URLSearchParams({ q: query })}`,
      ),
    enabled: query.length > 0,
  });
  return (
    <div className="space-y-2">
      <Field label="종목 검색 (이름 또는 6자리 코드)">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
          }}
        />
      </Field>
      <ErrorAlert error={symbols.error} />
      {symbols.data?.symbols.slice(0, 8).map((s) => (
        <Button
          key={s.symbol}
          type="button"
          variant="outline"
          size="sm"
          className="mr-2"
          onClick={() => {
            onChange(s.symbol);
            setQuery(s.symbol);
          }}
        >
          {s.name} ({s.symbol})
        </Button>
      ))}
      <p className="text-sm text-muted-foreground">
        토스 제공 KOSPI·KOSDAQ 보통주만 선택할 수 있습니다.
      </p>
      <p className="text-sm text-muted-foreground">
        선택 종목: {value || "없음"}
      </p>
    </div>
  );
}
function RangeFields({
  from,
  to,
  timeframe,
  setFrom,
  setTo,
  setTimeframe,
  max,
  min = intradayRetentionDate(),
  permittedTimeframes = ["1m", "5m", "15m"],
}: {
  from: string;
  to: string;
  timeframe: IntradayTimeframe;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  setTimeframe: (v: IntradayTimeframe) => void;
  max: string;
  min?: string;
  permittedTimeframes?: readonly IntradayTimeframe[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="시작일">
        <Input
          type="date"
          min={min}
          max={max}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </Field>
      <Field label="종료일">
        <Input
          type="date"
          min={min}
          max={max}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </Field>
      <Field label="봉 주기">
        <Select
          value={timeframe}
          onValueChange={(value) => setTimeframe(value as IntradayTimeframe)}
        >
          <SelectTrigger
            className="h-9 w-full rounded-md bg-background px-3"
            aria-label="봉 주기"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {!permittedTimeframes.includes(timeframe) && (
              <SelectItem value={timeframe}>{Number.parseInt(timeframe, 10)}분 (기존 설정 · 변경 필요)</SelectItem>
            )}
            {permittedTimeframes.map((value) => (
              <SelectItem key={value} value={value}>{Number.parseInt(value, 10)}분</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
export function IntradayListPage() {
  const controls = useHistoryControls(true);
  const tablePreferences = useHistoryTablePreferences();
  const columns = tablePreferences.visibleColumns.map((column) => column.id);
  const historyEditing = useHistoryEditing();
  const [deletion, setDeletion] = useState<{ strategyId: string; ids: string[] } | null>(null);
  const groups = useQuery({
    queryKey: ["intraday-runs", "groups"],
    queryFn: () => api<{ groups: HistoryGroup[] }>("/intraday/runs/groups"),
    refetchInterval: 5_000,
  });
  const limit = controls.view === "cards" ? 6 : 10;
  const pages = useHistoryQueries({
    queries: (groups.data?.groups ?? []).map((group) => {
      const params = new URLSearchParams({
        strategyId: group.strategyId,
        sort: controls.sort,
        dir: controls.dir,
        limit: String(limit),
        offset: String((controls.page(group.strategyId) - 1) * limit),
      });
      const scope = new URLSearchParams(params);
      scope.delete("offset");
      return {
        placeholderKey: group.strategyId,
        placeholderScope: scope.toString(),
        queryKey: ["intraday-runs", "history", params.toString()],
        queryFn: () =>
          api<{ runs: IntradayRunSummary[]; total: number }>(
            `/intraday/runs?${params}`,
          ),
        enabled: !controls.collapsed(group.strategyId),
        refetchInterval: 5_000,
      };
    }),
  });
  const visibleRuns = pages.flatMap((query, index) =>
    controls.collapsed(groups.data?.groups[index]?.strategyId ?? "")
      ? [] : (query.data?.runs ?? []),
  );
  const missingNames = useStockNames(controls.view === "table"
    ? [...new Set(visibleRuns.filter(run => !run.symbolName).map(run => run.request.symbol))].sort()
    : []);
  const extras = useBacktestHistoryExtras(visibleRuns.map((run) => run.id), 5_000, "intraday");
  const extrasById = new Map(extras.data?.summaries.map((item) => [item.jobId, item]) ?? []);
  const corrections = (groups.data?.groups ?? []).flatMap((group, index) => {
    const query = pages[index];
    if (
      !query?.data || query.isPlaceholderData ||
      query.isFetching ||
      controls.collapsed(group.strategyId)
    )
      return [];
    const last = Math.max(1, Math.ceil(query.data.total / limit));
    return controls.page(group.strategyId) > last
      ? [{ id: group.strategyId, page: last }]
      : [];
  });
  const correctionKey = JSON.stringify(corrections);
  const { correctPages } = controls;
  useEffect(() => {
    const pending = JSON.parse(correctionKey) as Array<{
      id: string;
      page: number;
    }>;
    if (!pending.length) return;
    correctPages(pending);
  }, [correctionKey, correctPages]);
  return (
    <div className="space-y-4">
      <BacktestHeader
        mode="intraday"
        actions={<NewBacktestButton mode="intraday" />}
      />
      <HistoryToolbar controls={controls} intraday onChange={() => historyEditing.clear()} />
      <ErrorAlert error={groups.error} />
      {groups.isLoading ? (
        <p className="text-sm text-muted-foreground">
          이력을 불러오는 중입니다.
        </p>
      ) : null}
      {groups.data?.groups.length === 0 ? <p>백테스트가 없습니다.</p> : null}
      {deletion ? <BacktestDeleteDialog mode="intraday" ids={deletion.ids} onClose={() => setDeletion(null)} onDeleted={() => { historyEditing.setEditing(deletion.strategyId, false); setDeletion(null); }} /> : null}
      <HistoryLayout columns={columns} view={controls.view}>
        {(groups.data?.groups ?? []).map((group, index) => {
          const query = pages[index];
          const { editing, selected } = historyEditing.state(group.strategyId);
          const runs = controls.collapsed(group.strategyId) || query?.isPlaceholderData ? [] : (query?.data?.runs ?? []);
          const deletableIds = runs.filter((run) => !active(run.status)).map((run) => run.id);
          const selectedIds = deletableIds.filter((id) => selected.has(id));
          const strategy = INTRADAY_STRATEGIES.find(
            (s) => s.id === group.strategyId,
          );
          const name = strategy?.name ?? group.strategyId;
          return (
            <HistoryStrategyGroup
              key={group.strategyId}
              name={name}
              description={strategy?.description}
              total={group.total}
              collapsed={controls.collapsed(group.strategyId)}
              actions={<HistoryEditActions
                editing={editing}
                onEditingChange={(value) => {
                  if (value && controls.collapsed(group.strategyId)) controls.toggle(group.strategyId);
                  historyEditing.setEditing(group.strategyId, value);
                }}
                total={deletableIds.length}
                selected={selectedIds.length}
                pending={deletion !== null}
                selectionDisabled={query?.isPlaceholderData}
                onToggleAll={() => historyEditing.toggleAll(group.strategyId, deletableIds)}
                onRemoveSelected={() => setDeletion({ strategyId: group.strategyId, ids: selectedIds })}
              />}
              onToggle={() => {
                controls.toggle(group.strategyId);
                historyEditing.setEditing(group.strategyId, false);
              }}
            >
              <ErrorAlert error={query?.error} />
              {controls.view === "cards" ? (
                <div data-pagination-content aria-busy={query?.isPlaceholderData} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
                  {query?.data?.runs.map((run) => {
                    const summary = extrasById.get(run.id);
                    return (
                      <div key={run.id} className="min-w-0 max-w-[360px]">
                        <HistoryResultCard
                          id={run.id}
                          mode="intraday"
                          href={`/backtests/intraday/${encodeURIComponent(run.id)}`}
                          period={historyPeriod(run.request.period.from, run.request.period.to)}
                          date={run.createdAtMs}
                          description={`${run.request.symbol} · ${run.request.timeframe}`}
                          status={run.status === "COMPLETED" ? null : <IntradayStatusBadge status={run.status} />}
                          summary={summary}
                          editing={editing}
                          selected={selected.has(run.id)}
                          deletable={!active(run.status)}
                          selectionDisabled={deletion !== null || query?.isPlaceholderData}
                          onToggle={() => historyEditing.toggleOne(group.strategyId, run.id)}
                          error={run.error}
                          metrics={run.status === "COMPLETED" && run.metrics ? {
                            returnPct: run.metrics.returnPct, cagrPct: null, mddPct: run.metrics.maxDrawdownPct,
                          } : undefined}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <HistoryTable columns={columns} busy={query?.isPlaceholderData}>
                    {query?.data?.runs.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="sticky left-0 z-10 bg-background py-3 align-top whitespace-normal">
                          <div className="flex items-center gap-1 whitespace-nowrap">
                            {editing ? (
                              <>
                                <Checkbox
                                  checked={selected.has(run.id)}
                                  disabled={active(run.status) || deletion !== null || query?.isPlaceholderData}
                                  onCheckedChange={() => historyEditing.toggleOne(group.strategyId, run.id)}
                                  aria-label={`${time(run.createdAtMs)} 백테스트 선택`}
                                />
                                <span className="whitespace-nowrap">
                                  {historyPeriod(run.request.period.from, run.request.period.to)}
                                </span>
                              </>
                            ) : (
                              <Link
                                className="whitespace-nowrap underline"
                                to={`/backtests/intraday/${encodeURIComponent(run.id)}`}
                              >
                                {historyPeriod(run.request.period.from, run.request.period.to)}
                              </Link>
                            )}
                          </div>
                          <p className="mt-1 w-max whitespace-nowrap text-muted-foreground" title={run.request.symbol}>
                            {run.symbolName ?? missingNames.get(run.request.symbol)?.name ?? "종목명 미등록"}
                          </p>
                          <HistoryResultDetails
                            id={run.id}
                            mode="intraday"
                            status={run.status === "COMPLETED" ? null : <IntradayStatusBadge status={run.status} />}
                            summary={extrasById.get(run.id)}
                            editing={editing}
                          />
                          {run.error ? (
                            <p className="text-destructive">
                              {run.error}
                            </p>
                          ) : null}
                        </TableCell>
                        <HistoryMetricCells columns={columns} values={{
                          return: run.metrics?.returnPct,
                          mdd: run.metrics?.maxDrawdownPct,
                          date: run.createdAtMs,
                          sharpe: run.metrics?.sharpe,
                          validation: extrasById.has(run.id) ? { count: extrasById.get(run.id)!.validation.experimentCount, stddev: extrasById.get(run.id)!.validation.returns.sampleStdDev } : undefined,
                        }} />
                      </TableRow>
                    ))}
                </HistoryTable>
              )}
              {query?.data ? (
                <HistoryPager
                  strategyName={name}
                  page={controls.page(group.strategyId)}
                  total={query.data.total}
                  limit={limit}
                  pending={query.isPlaceholderData}
                  onPage={(page) => {
                    controls.setPage(group.strategyId, page);
                    historyEditing.clear(group.strategyId);
                  }}
                />
              ) : null}
            </HistoryStrategyGroup>
          );
        })}
      </HistoryLayout>
      <details className="space-y-3">
        <summary className="cursor-pointer font-semibold">
          분봉 전략 소개
        </summary>
        <section aria-label="분봉 전략" className="space-y-3">
          <div>
            <h3 className="font-semibold">분봉 전략</h3>
            <p className="text-sm text-muted-foreground">
              서로 다른 장세를 검증할 수 있는 기본 전략입니다. 현재 분봉
              백테스트에서 사용할 수 있습니다.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {INTRADAY_STRATEGIES.map((strategy) => (
              <Card key={strategy.id}>
                <CardContent className="flex h-full flex-col items-start gap-2 py-4">
                  <p className="text-xs text-muted-foreground">
                    {strategy.regime}
                  </p>
                  <h4 className="font-semibold">{strategy.name}</h4>
                  <p className="text-sm">{strategy.description}</p>
                  <p className="text-sm text-muted-foreground">
                    {strategy.caution}
                  </p>
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="mt-auto"
                  >
                    <Link
                      to={`/backtests/intraday/new?strategy=${strategy.id}`}
                      aria-label={`${strategy.name} 백테스트`}
                    >
                      이 전략으로 설정
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </details>
    </div>
  );
}
export function IntradayNewPage() {
  const [search] = useSearchParams();
  const cloneId = search.get("clone");
  const clone = useQuery({
    queryKey: ["intraday-run", cloneId],
    queryFn: () => api<IntradayRun>(`/intraday/runs/${encodeURIComponent(cloneId ?? "")}`),
    enabled: !!cloneId,
  });
  if (cloneId && (!clone.data || isUnavailableApiError(clone.error))) {
    return <div className="space-y-4"><BacktestHeader mode="intraday" title="새 백테스트" />{clone.error ? <ErrorAlert error={clone.error} /> : <p>복제 설정을 불러오는 중입니다.</p>}</div>;
  }
  const initialRequest = (() => {
    const selected = INTRADAY_STRATEGIES.find(
      (s) => s.id === search.get("strategy"),
    );
    const d = defaults(selected?.id);
    return {
      ...d,
      symbol: search.get("symbol") ?? d.symbol,
      period: {
        from: search.get("from") ?? d.period.from,
        to: search.get("to") ?? d.period.to,
      },
    };
  })();
  return <IntradayNewEditor key={cloneId ?? `new:${search.toString()}`} initialRequest={clone.data?.request ?? initialRequest} cloneError={clone.error} />;
}

function IntradayNewEditor({ initialRequest, cloneError }: { initialRequest: IntradayRequest; cloneError: unknown }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [request, setRequest] = useState(initialRequest);
  const strategy = getIntradayStrategy(request.strategyId);
  const [validation, setValidation] = useState("");
  const submit = useMutation({
    mutationFn: (body: IntradayRequest) =>
      postJson<IntradayRun>("/intraday/runs", body),
    onSuccess: (run) => {
      client.setQueryData(["intraday-run", run.id], run);
      void client.invalidateQueries({ queryKey: ["intraday-runs"] });
      void navigate(`/backtests/intraday/${encodeURIComponent(run.id)}`);
    },
  });
  const numberField = (
    label: string,
    value: number,
    update: (n: number) => void,
    step = "1",
    bounds?: { min: number; max: number },
  ) => (
    <Field label={label}>
      <Input
        type="number"
        step={step}
        min={bounds?.min}
        max={bounds?.max}
        value={value}
        onChange={(e) => update(Number(e.target.value))}
      />
    </Field>
  );
  const params = (key: string, n: number) =>
    setRequest(
      (r) =>
        ({
          ...r,
          parameters: { ...r.parameters, [key]: n },
        }) as IntradayRequest,
    );
  const execution = (
    key: Exclude<keyof IntradayRequest["execution"], "holdingPolicy">,
    n: number,
  ) => setRequest((r) => ({ ...r, execution: { ...r.execution, [key]: n } }));
  return (
    <div className="space-y-4">
      <BacktestHeader mode="intraday" title="새 백테스트" />
      <p className="text-sm text-muted-foreground">
        토스 제공 시세 (거래소 구성 미확인), 수정주가 미적용. 필요한 데이터는
        실행 시 자동으로 준비합니다.
      </p>
      <ErrorAlert
        error={
          cloneError ||
          submit.error ||
          (validation ? new Error(validation) : null)
        }
      />
      <SymbolSearch
        value={request.symbol}
        onChange={(symbol) => setRequest((r) => ({ ...r, symbol }))}
      />
      <RangeFields
        min={intradayFirstBacktestDate()}
        from={request.period.from}
        to={request.period.to}
        timeframe={request.timeframe}
        permittedTimeframes={strategy.timeframes}
        setFrom={(from) =>
          setRequest((r) => ({ ...r, period: { ...r.period, from } }))
        }
        setTo={(to) =>
          setRequest((r) => ({ ...r, period: { ...r.period, to } }))
        }
        setTimeframe={(timeframe) => setRequest((r) => ({ ...r, timeframe }))}
        max={yesterday()}
      />
      <Card>
        <CardContent className="space-y-3 py-4">
          <Field label="분봉 전략">
            <Select
              value={request.strategyId}
              onValueChange={(value) => {
                const next = INTRADAY_STRATEGIES.find((s) => s.id === value);
                if (!next) return;
                setRequest(
                  (r) =>
                    ({
                      ...r,
                      strategyId: next.id,
                      timeframe: next.timeframes.includes(r.timeframe) ? r.timeframe : next.defaultTimeframe,
                      parameters: { ...next.defaults },
                    }) as IntradayRequest,
                );
                setValidation("");
              }}
            >
              <SelectTrigger className="w-full" aria-label="분봉 전략">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTRADAY_STRATEGIES.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p className="text-sm">
            {strategy.entry} {strategy.exit}
          </p>
          <p className="text-sm text-muted-foreground">{strategy.caution}</p>
          <p className="text-xs text-muted-foreground">
            전략 변경 시 지표·손절·익절 파라미터에 해당 전략의 기본값을
            적용합니다.
          </p>
          <p className="text-sm text-muted-foreground">
            지표는 매일 초기화합니다. 09:00~15:20, 진입 마감 15:10, 청산 신호
            15:15. 청산 미체결 시 보유 상태로 해당 일에 시뮬레이션을 중단합니다.
          </p>
          <p className="text-sm text-muted-foreground">
            하루 진입 횟수는 실제 포지션을 연 횟수이며 부분 체결은 한 번으로 셉니다.
            재진입 대기는 전량 청산 후 시작합니다. 최대 보유 시간은 확정된 1분봉에서 확인한 뒤
            설정된 지연을 적용해 청산하므로 정확한 보유 시간을 보장하지 않습니다.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[...INTRADAY_TRADE_CONTROL_FIELDS, ...strategy.fields].map((field) => (
              <div key={field.key}>
                {numberField(
                  field.label,
                  (request.parameters as Record<string, number>)[field.key] ??
                    (strategy.defaults as Record<string, number>)[field.key] ?? 0,
                  (n) => params(field.key, n),
                  String(field.step ?? 1),
                  field,
                )}
              </div>
            ))}
            {numberField(
              "투자 비율 (%)",
              request.parameters.allocationPct,
              (n) => params("allocationPct", n),
            )}
            {numberField(
              "손절 (%)",
              request.parameters.stopLossPct,
              (n) => params("stopLossPct", n),
              "0.1",
            )}
            {numberField(
              "익절 (%)",
              request.parameters.takeProfitPct,
              (n) => params("takeProfitPct", n),
              "0.1",
            )}
            {numberField("초기 자금 (원)", request.initialCash, (n) =>
              setRequest((r) => ({ ...r, initialCash: n })),
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 py-4">
          <h3 className="font-semibold">체결 및 비용 가정</h3>
          <p className="text-sm text-muted-foreground">
            수수료와 비용은 수정 가능한 모의 가정입니다.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {numberField(
              "수수료 (bps)",
              request.execution.commissionBps,
              (n) => execution("commissionBps", n),
              "0.1",
            )}
            {numberField(
              "세금 (bps)",
              request.execution.taxBps,
              (n) => execution("taxBps", n),
              "0.1",
            )}
            {numberField(
              "슬리피지 (bps)",
              request.execution.slippageBps,
              (n) => execution("slippageBps", n),
              "0.1",
            )}
            {numberField("지연 (ms)", request.execution.latencyMs, (n) =>
              execution("latencyMs", n),
            )}
            {numberField(
              "주문 만료 (분)",
              request.execution.orderExpiryMinutes,
              (n) => execution("orderExpiryMinutes", n),
            )}
            {numberField(
              "거래량 참여 한도 (%)",
              request.execution.maxParticipationPct,
              (n) => execution("maxParticipationPct", n),
              "0.1",
            )}
          </div>
        </CardContent>
      </Card>
      <Button
        disabled={submit.isPending}
        onClick={() => {
          const parsed = intradayRunRequestSchema.safeParse(request);
          if (!parsed.success) {
            setValidation(
              parsed.error.issues.map((i) => i.message).join(" · "),
            );
            return;
          }
          if (
            request.period.from < intradayFirstBacktestDate() ||
            request.period.to > yesterday()
          ) {
            setValidation(
              "백테스트 기간은 보관된 전체 날짜부터 어제까지입니다.",
            );
            return;
          }
          setValidation("");
          submit.mutate(parsed.data);
        }}
      >
        {submit.isPending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
        {submit.isPending ? "실행 요청 중…" : "백테스트 실행"}
      </Button>
    </div>
  );
}
function ResultChart({
  request,
  revision,
  signals,
  fills,
}: {
  request: IntradayRequest;
  revision: string;
  signals: IntradaySignal[];
  fills: IntradayFill[];
}) {
  const [from, setFrom] = useState(request.period.from);
  const [to, setTo] = useState(request.period.to);
  const [timeframe, setTimeframe] = useState(request.timeframe);
  return (
    <div className="space-y-3">
      <RangeFields
        from={from}
        to={to}
        timeframe={timeframe}
        setFrom={setFrom}
        setTo={setTo}
        setTimeframe={setTimeframe}
        max={yesterday()}
      />
      <IntradayChartView
        symbol={request.symbol}
        from={from}
        to={to}
        timeframe={timeframe}
        expectedRevision={revision}
        signals={signals}
        fills={fills}
      />
    </div>
  );
}
export function IntradayDetailPage() {
  const { id = "" } = useParams();
  return <IntradayResult key={id} id={id} />;
}

function IntradayResult({ id }: { id: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const run = useQuery({
    queryKey: ["intraday-run", id],
    queryFn: () => api<IntradayRun>(`/intraday/runs/${encodeURIComponent(id)}`),
    refetchInterval: (q) => q.state.data && active(q.state.data.status) ? 1000 : false,
    refetchIntervalInBackground: false,
  });
  const cancel = useMutation({
    mutationFn: () => api<IntradayRun>(`/intraday/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (value) => {
      client.setQueryData(["intraday-run", id], value);
      void client.invalidateQueries({ queryKey: ["intraday-runs"] });
    },
  });
  const clone = useMutation({
    mutationFn: () => api<IntradayRun>(`/intraday/runs/${encodeURIComponent(id)}/clone`, { method: "POST" }),
    onSuccess: (value) => {
      void client.invalidateQueries({ queryKey: ["intraday-runs"] });
      void client.invalidateQueries({ queryKey: ["jobs"] });
      void navigate(`/backtests/intraday/${encodeURIComponent(value.id)}`);
    },
    onError: (error) => toast.error(error.message),
  });
  const r = run.data;
  const result = r?.result;
  const names = useStockNames(r ? [r.request.symbol] : []);
  const name = r ? names.get(r.request.symbol)?.name : undefined;
  const trades = useMemo(() => result ? summarizeIntradayTrades(result) : null, [result]);
  const points = useMemo(() => result ? downsampleLttb(result.equity.map((point) => ({ tsMs: point.endMs, value: point.equity })), 1000) : [], [result]);
  const m = result?.metrics;
  const commission = result?.fills.reduce((sum, fill) => sum + fill.commission, 0) ?? 0;
  const tax = result?.fills.reduce((sum, fill) => sum + fill.tax, 0) ?? 0;
  const slippage = Math.max(0, (m?.totalCosts ?? 0) - commission - tax);
  const completed = r?.status === "COMPLETED";
  return <div className="min-w-0 space-y-4">
    <BacktestBreadcrumbs jobId={id} mode="intraday" />
    {run.isLoading ? <div role="status" aria-label="백테스트 불러오는 중" className="space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40 w-full" /></div> : null}
    <ErrorAlert error={run.error || cancel.error || clone.error || (r?.error ? new Error(r.error) : null)} />
    {r ? <>
      <header className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{getIntradayStrategy(r.request.strategyId).name}</h2>
          {r.status !== "COMPLETED" ? <span className="text-sm text-muted-foreground">{statusLabel[r.status]}</span> : null}
          {completed && result ? <Button variant="outline" onClick={() => void navigate(`/trading?sourceRunId=${encodeURIComponent(id)}`, { state: { tradingRequestId: crypto.randomUUID() } })}>이 설정으로 매매 준비</Button> : null}
          <div className={cn("flex flex-wrap items-center gap-2", active(r.status) ? "ml-auto" : "w-full justify-end sm:ml-auto sm:w-auto")}>
            {active(r.status) ? <Button variant="outline" className="h-11" disabled={cancel.isPending} onClick={() => cancel.mutate()}>실행 취소</Button> :
              <ResultActions onClone={() => clone.mutate()} clonePending={clone.isPending} searchHref={`/backtests/intraday/${encodeURIComponent(id)}/search`}
                reconfigureHref={`/backtests/intraday/new?clone=${encodeURIComponent(id)}`}
                exportHref={completed && result ? `/api/v1/intraday/runs/${encodeURIComponent(id)}/export` : undefined}
                onDelete={() => setDeleteOpen(true)} />}
          </div>
        </div>
        <p className="max-w-full overflow-x-auto whitespace-nowrap pb-1 text-sm text-muted-foreground" aria-label="백테스트 실행 정보">
          {name ? `${name} (${r.request.symbol})` : r.request.symbol} · {Number.parseInt(r.request.timeframe, 10)}분 · {r.request.period.from} ~ {r.request.period.to} · 생성 {formatIntradayTime(r.createdAtMs)}
        </p>
      </header>
      {active(r.status) && !run.isError ? <BacktestProgressCard label={cancel.isPending ? "취소 요청 중" : statusLabel[r.status]}>
        <p className="text-xs text-muted-foreground">{r.status === "QUEUED" ? "실행 순서를 기다리고 있습니다." : r.status === "PREPARING" ? "저장된 분봉을 확인하고 필요한 데이터를 수집하고 있습니다." : "분봉으로 전략을 계산하고 있습니다."}</p>
      </BacktestProgressCard> : null}
    </> : null}
    {completed && result && m && trades ? <>
      <section aria-label="성과 요약" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "누적 수익률", value: formatSignedPct(m.returnPct), className: pnlClass(m.returnPct) },
          { label: "손익", value: formatSignedKrw(m.pnl), className: pnlClass(m.pnl) },
          { label: "MDD", value: formatSignedPct(m.maxDrawdownPct), className: pnlClass(m.maxDrawdownPct) },
          { label: "Sharpe", value: formatNumber(m.sharpe), className: sharpeClass(m.sharpe) },
          { label: "승률 (매도 체결 기준)", value: trades.winRate === null ? "—" : `${trades.winRate.toFixed(1)}%`, className: "" },
          { label: "매도 체결 수 (부분청산 포함)", value: `${trades.tradeCount}건`, className: "" },
        ].map((card) => <Card key={card.label}><CardContent className="px-4 py-3"><p className="text-xs text-muted-foreground">{card.label}</p><p className={cn("break-words text-lg font-semibold tabular-nums", card.className)}>{card.value}</p></CardContent></Card>)}
        <Card className="col-span-full"><CardContent className="grid grid-cols-2 gap-4 px-4 py-3" aria-label="비용 및 보유기간">
          <div className="min-w-0"><p className="text-xs text-muted-foreground">총 비용</p><p className="break-words text-lg font-semibold tabular-nums">{formatKrw(Math.round(commission) + Math.round(tax) + Math.round(slippage))}</p><p className="mt-1 text-xs text-muted-foreground"><span className="inline-block">수수료 {formatKrw(commission)}</span> · <span className="inline-block">세금 {formatKrw(tax)}</span> · <span className="inline-block">슬리피지 {formatKrw(slippage)}</span></p></div>
          <div className="min-w-0"><p className="text-xs text-muted-foreground">평균 보유</p><p className="text-lg font-semibold tabular-nums">{trades.averageHoldingMinutes === null ? "—" : formatDuration(trades.averageHoldingMinutes * 60_000)}</p><p className="mt-1 text-xs text-muted-foreground">매도 체결 기준</p></div>
        </CardContent></Card>
      </section>
      <ExperimentSummary jobId={id} mode="intraday" />
      <ResultChart key={id} request={result.request} revision={result.dataRevision} signals={result.signals} fills={result.fills} />
      <EquityChart points={points} formatTimestamp={formatIntradayTime} formatTick={(ts) => formatIntradayTime(ts).slice(result.request.period.from === result.request.period.to ? 11 : 5, result.request.period.from === result.request.period.to ? 16 : 10)} summary={`초기 ${formatKrw(result.request.initialCash)} → 최종 ${formatKrw(result.equity.at(-1)?.equity ?? result.request.initialCash + m.pnl)} (${formatSignedPct(m.returnPct)})${result.equity.length > points.length ? ` · ${result.equity.length.toLocaleString("ko-KR")}포인트를 ${points.length}포인트로 축약 표시` : ""}`} />
      <IntradayTradesSection result={result} name={name} />
      <IntradayReproductionInfo result={result} />
      <Card aria-label="시세 및 체결 참고"><CardHeader><CardTitle className="text-base">시세 및 체결 참고</CardTitle></CardHeader><CardContent className="space-y-3 text-sm text-muted-foreground">
        {result.position.quantity > 0 ? <p role="alert" className="text-destructive">미청산 수량 {money(result.position.quantity)}주 · 미청산 손익은 평가금액에 포함되며 승률과 매도 체결 수에서는 제외됩니다.</p> : null}
        <ul className="list-disc space-y-2 pl-4">{result.warnings.map((warning) => <li role="alert" key={warning}>{warning}</li>)}
          <li>매도 체결은 부분청산도 각각 한 건으로 집계합니다. 진입 시각·보유기간은 포지션의 최초 진입 기준이며, 진입가는 매도 직전의 이동평균 매수가입니다.</li>
          <li>거래 표의 비용은 배분된 매수 수수료와 매도 수수료·세금입니다. 순손익과 승률에 이 비용을 반영하며, 체결가에 포함된 슬리피지를 다시 차감하지 않습니다. 총 비용에는 슬리피지 추정 비용도 포함됩니다.</li>
          <li>시세는 비수정주가이며 시각은 한국 표준시(KST)입니다. 거래 중단·누락 구간에는 신호와 체결을 만들지 않습니다.</li>
        </ul>
        <p>전략 버전 {result.strategyVersion} · {money(result.processedBars)}개 분봉 처리 · {result.session}</p>
      </CardContent></Card>
    </> : null}
    {deleteOpen ? <BacktestDeleteDialog mode="intraday" ids={[id]} onClose={() => setDeleteOpen(false)} onDeleted={() => { client.removeQueries({ queryKey: ["intraday-run", id], exact: true }); setDeleteOpen(false); void navigate("/backtests/intraday"); }} /> : null}
  </div>;
}

function formatIntradayTime(ms: number): string {
  return new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replaceAll("-", ".").replace("T", " ");
}
