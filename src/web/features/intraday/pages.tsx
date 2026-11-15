import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BacktestHeader, NewBacktestButton } from "../backtests/backtest-header";
import {
  HistoryPager,
  HistoryStrategyGroup,
  HistoryToolbar,
  historyPeriod,
  useHistoryControls,
} from "../backtests/history-controls";
import type { HistoryGroup } from "../../../shared/schemas/backtest-history";
import { formatSignedPct, pnlClass } from "@/lib/format";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  INTRADAY_STRATEGIES,
  getIntradayStrategy,
  type IntradayStrategyId,
} from "../../../shared/schemas/intraday-strategies";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, postJson } from "@/lib/api-client";
import {
  intradayDate,
  intradayFirstBacktestDate,
  intradayRequestSchema,
  intradayRetentionDate,
  type IntradayChart,
  type IntradayCollection,
  type IntradayDataOverview,
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
  RUNNING: "진행 중",
  COMPLETED: "완료",
  FAILED: "실패",
  CANCELLED: "취소",
};
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
    timeframe: "5m",
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
}: {
  from: string;
  to: string;
  timeframe: IntradayTimeframe;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  setTimeframe: (v: IntradayTimeframe) => void;
  max: string;
  min?: string;
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
        <select
          className="h-9 rounded-md border bg-background px-3"
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value as IntradayTimeframe)}
        >
          <option value="1m">1분</option>
          <option value="5m">5분</option>
          <option value="15m">15분</option>
        </select>
      </Field>
    </div>
  );
}
function Chart({
  symbol,
  from,
  to,
  timeframe,
  expectedRevision,
  refreshRevision,
  signals = [],
  fills = [],
}: {
  symbol: string;
  from: string;
  to: string;
  timeframe: IntradayTimeframe;
  expectedRevision?: string;
  refreshRevision?: string;
  signals?: IntradaySignal[];
  fills?: IntradayFill[];
}) {
  const [offset, setOffset] = useState(0);
  const chart = useQuery({
    queryKey: ["intraday-chart", symbol, from, to, timeframe, refreshRevision],
    queryFn: () =>
      api<IntradayChart>(
        `/intraday/chart?${new URLSearchParams({ symbol, from, to, timeframe })}`,
      ),
    enabled: /^\d{6}$/.test(symbol) && !!from && !!to && from <= to,
  });
  const all = chart.data?.bars ?? [];
  const start = Math.max(0, Math.min(offset, Math.max(0, all.length - 80)));
  const bars = all.slice(start, start + 80);
  const low = Math.min(...bars.map((b) => b.low));
  const high = Math.max(...bars.map((b) => b.high));
  const maxVolume = Math.max(1, ...bars.map((b) => b.volume));
  const y = (v: number) => 180 - ((v - low) / (high - low || 1)) * 160;
  const showMarkers =
    !!expectedRevision && chart.data?.revision === expectedRevision;
  const barMs = Number.parseInt(timeframe, 10) * 60_000;
  return (
    <div className="space-y-2">
      <ErrorAlert error={chart.error} />
      {chart.isFetching && <p>차트 불러오는 중…</p>}
      {expectedRevision &&
        chart.data &&
        chart.data.revision !== expectedRevision && (
          <Alert>
            <AlertDescription>
              수집 데이터가 갱신되어 실행 당시 차트와 다를 수 있습니다.
            </AlertDescription>
          </Alert>
        )}
      {chart.data?.truncated && (
        <Alert>
          <AlertDescription>
            표시 가능한 봉 수를 초과했습니다. 날짜 범위를 좁혀 주세요.
          </AlertDescription>
        </Alert>
      )}
      {chart.data && (
        <p className="text-sm text-muted-foreground">
          {chart.data.totalBars}개 봉 · 누락 구간 {chart.data.gaps.length}개
          {chart.data.gaps.map(
            (g) =>
              ` · ${time(g.fromMs)} ~ ${time(g.toMs)} (${g.missingMinutes}분)`,
          )}
        </p>
      )}
      {bars.length > 0 ? (
        <>
          {showMarkers && (
            <p className="text-sm text-muted-foreground">
              ▲ 보라색: 신호 · ● 초록색: 체결 (한국 시각)
            </p>
          )}
          <svg
            viewBox="0 0 800 250"
            role="img"
            aria-label="가격 캔들 및 거래량 차트"
            className="w-full rounded border bg-background"
          >
            <line
              x1="0"
              y1="190"
              x2="800"
              y2="190"
              stroke="currentColor"
              opacity=".2"
            />
            {bars.map((b, i) => {
              const x = ((i + 0.5) * 800) / bars.length;
              const color = b.close >= b.open ? "#ef4444" : "#3b82f6";
              return (
                <g key={b.endMs}>
                  <title>{`${time(b.endMs)} 시가 ${money(b.open)} 고가 ${money(b.high)} 저가 ${money(b.low)} 종가 ${money(b.close)} 거래량 ${money(b.volume)}`}</title>
                  <line
                    x1={x}
                    x2={x}
                    y1={y(b.high)}
                    y2={y(b.low)}
                    stroke={color}
                  />
                  <rect
                    x={x - 3}
                    y={Math.min(y(b.open), y(b.close))}
                    width="6"
                    height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
                    fill={color}
                  />
                  {showMarkers &&
                    signals
                      .filter(
                        (signal) =>
                          signal.atMs > b.endMs - barMs &&
                          signal.atMs <= b.endMs,
                      )
                      .map((signal, index) => (
                        <path
                          key={signal.id}
                          d={`M ${x} ${Math.max(3, y(b.high) - 13 - index * 9)} l -5 8 h 10 z`}
                          fill="#a855f7"
                          aria-label={`신호 ${signal.side} ${time(signal.atMs)}`}
                        >
                          <title>{`신호 ${signal.side} · ${time(signal.atMs)} (KST)`}</title>
                        </path>
                      ))}
                  {showMarkers &&
                    fills
                      .filter(
                        (fill) =>
                          fill.atMs >= b.endMs - barMs && fill.atMs < b.endMs,
                      )
                      .map((fill, index) => (
                        <circle
                          key={`${fill.orderId}-${fill.atMs}-${index}`}
                          cx={x}
                          cy={Math.min(185, y(b.low) + 8 + index * 9)}
                          r="4"
                          fill="#16a34a"
                          aria-label={`체결 ${fill.side} ${time(fill.atMs)}`}
                        >
                          <title>{`체결 ${fill.side} · ${time(fill.atMs)} (KST)`}</title>
                        </circle>
                      ))}
                  <rect
                    x={x - 3}
                    y={245 - (b.volume / maxVolume) * 48}
                    width="6"
                    height={(b.volume / maxVolume) * 48}
                    fill={color}
                    opacity=".6"
                  />
                </g>
              );
            })}
          </svg>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={start === 0}
              onClick={() => setOffset(Math.max(0, start - 80))}
            >
              이전 봉
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={start + 80 >= all.length}
              onClick={() => setOffset(start + 80)}
            >
              다음 봉
            </Button>
            <span>
              {time(bars[0]!.endMs)} ~ {time(bars[bars.length - 1]!.endMs)}{" "}
              (KST)
            </span>
          </div>
        </>
      ) : (
        chart.data && (
          <p className="text-sm text-muted-foreground">
            표시할 데이터가 없습니다.
          </p>
        )
      )}
    </div>
  );
}
export function IntradayDataPage() {
  const [symbol, setSymbol] = useState("");
  const [from, setFrom] = useState(intradayRetentionDate());
  const [to, setTo] = useState(intradayDate(Date.now()));
  const [tf, setTf] = useState<IntradayTimeframe>("5m");
  const client = useQueryClient();
  const overview = useQuery({
    queryKey: ["intraday-data"],
    queryFn: () => api<IntradayDataOverview>("/intraday/data"),
    refetchInterval: (q) =>
      q.state.data?.collections.some((c) => active(c.status)) ? 1000 : false,
  });
  const collect = useMutation({
    mutationFn: () =>
      postJson<IntradayCollection>("/intraday/collections", {
        symbol,
        period: { from, to },
      }),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["intraday-data"] }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api<IntradayCollection>(
        `/intraday/collections/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["intraday-data"] }),
  });
  const stored = overview.data?.symbols.find((s) => s.symbol === symbol);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        토스 제공 시세 (거래소 구성 미확인) · 수정주가 미적용 · 1분봉 365일 보관
        · 완료된 봉만 수집
      </p>
      <ErrorAlert error={overview.error || collect.error || cancel.error} />
      {overview.data && !overview.data.configured && (
        <Alert variant="destructive">
          <AlertDescription>
            시세 수집을 사용할 수 없습니다. 연결 설정을 확인하세요.
          </AlertDescription>
        </Alert>
      )}
      <SymbolSearch value={symbol} onChange={setSymbol} />
      <RangeFields
        from={from}
        to={to}
        timeframe={tf}
        setFrom={setFrom}
        setTo={setTo}
        setTimeframe={setTf}
        max={intradayDate(Date.now())}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!/^\d{6}$/.test(symbol) || collect.isPending}
          onClick={() => collect.mutate()}
        >
          데이터 수집
        </Button>
        <Button asChild variant="outline">
          <Link
            to={`/backtests/intraday/new?${new URLSearchParams({ symbol, from: from < intradayFirstBacktestDate() ? intradayFirstBacktestDate() : from, to: to > yesterday() ? yesterday() : to })}`}
          >
            이 조건으로 백테스트
          </Link>
        </Button>
      </div>
      <p className="text-sm">
        저장 범위:{" "}
        {stored
          ? `${time(stored.firstEndMs)} ~ ${time(stored.lastEndMs)} · ${money(stored.bars)}개 · 갱신 ${time(stored.updatedAtMs)}`
          : "없음"}
      </p>
      {overview.data?.collections
        .filter((c) => !symbol || c.symbol === symbol)
        .map((c) => (
          <Card key={c.id}>
            <CardContent className="space-y-1 py-3 text-sm">
              <p>
                {c.symbol} · {c.period.from} ~ {c.period.to} ·{" "}
                {statusLabel[c.status]} · {money(c.fetchedBars)}개 봉
              </p>
              {c.error && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{c.error}</AlertDescription>
                </Alert>
              )}
              {active(c.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => cancel.mutate(c.id)}
                >
                  수집 취소
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      <Chart
        symbol={symbol}
        from={from}
        to={to}
        timeframe={tf}
        refreshRevision={stored?.revision}
      />
    </div>
  );
}
export function IntradayListPage() {
  const controls = useHistoryControls(true);
  const groups = useQuery({
    queryKey: ["intraday-runs", "groups"],
    queryFn: () => api<{ groups: HistoryGroup[] }>("/intraday/runs/groups"),
    refetchInterval: 5_000,
  });
  const limit = controls.view === "cards" ? 6 : 10;
  const pages = useQueries({
    queries: (groups.data?.groups ?? []).map((group) => {
      const params = new URLSearchParams({
        strategyId: group.strategyId,
        sort: controls.sort,
        dir: controls.dir,
        limit: String(limit),
        offset: String((controls.page(group.strategyId) - 1) * limit),
      });
      return {
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
  const corrections = (groups.data?.groups ?? []).flatMap((group, index) => {
    const query = pages[index];
    if (
      !query?.data ||
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
      <HistoryToolbar controls={controls} intraday />
      <ErrorAlert error={groups.error} />
      {groups.isLoading ? (
        <p className="text-sm text-muted-foreground">
          이력을 불러오는 중입니다.
        </p>
      ) : null}
      {groups.data?.groups.length === 0 ? <p>백테스트가 없습니다.</p> : null}
      {(groups.data?.groups ?? []).map((group, index) => {
        const query = pages[index];
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
            onToggle={() => controls.toggle(group.strategyId)}
          >
            <ErrorAlert error={query?.error} />
            {controls.view === "cards" ? (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
                {query?.data?.runs.map((run) => (
                  <Link
                    key={run.id}
                    className="max-w-[360px]"
                    to={`/backtests/intraday/${encodeURIComponent(run.id)}`}
                  >
                    <Card>
                      <CardContent className="space-y-2 py-4">
                        <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                          <span>{statusLabel[run.status]}</span>
                          <span>{time(run.createdAtMs)}</span>
                        </div>
                        <p className="whitespace-nowrap text-sm font-medium">
                          {historyPeriod(
                            run.request.period.from,
                            run.request.period.to,
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {run.request.symbol} · {run.request.timeframe}
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <p className="text-xs text-muted-foreground">
                              수익률
                            </p>
                            <p
                              className={`text-xl font-semibold tabular-nums ${pnlClass(run.metrics?.returnPct ?? null)}`}
                            >
                              {formatSignedPct(run.metrics?.returnPct ?? null)}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">
                              CAGR
                            </p>
                            <p className="text-xl font-semibold">—</p>
                          </div>
                        </div>
                        <p className="border-t pt-2 text-xs text-muted-foreground">
                          MDD{" "}
                          {formatSignedPct(run.metrics?.maxDrawdownPct ?? null)}
                        </p>
                        {run.error ? (
                          <p className="break-words text-destructive">
                            {run.error}
                          </p>
                        ) : null}
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            ) : (
              <table className="w-full table-fixed text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="w-[52%] py-2 text-left sm:w-[38%]">기간</th>
                    <th className="text-right">수익률</th>
                    <th className="text-right">CAGR</th>
                    <th className="hidden text-right sm:table-cell">MDD</th>
                    <th className="hidden text-right sm:table-cell">실행일</th>
                  </tr>
                </thead>
                <tbody>
                  {query?.data?.runs.map((run) => (
                    <tr key={run.id} className="border-t">
                      <td className="py-3">
                        <Link
                          className="whitespace-nowrap text-[11px] underline sm:text-xs"
                          to={`/backtests/intraday/${encodeURIComponent(run.id)}`}
                        >
                          {historyPeriod(
                            run.request.period.from,
                            run.request.period.to,
                          )}
                        </Link>
                        <div className="text-muted-foreground">
                          {statusLabel[run.status]} · {run.request.symbol}{" "}
                          <span className="sm:hidden">
                            · {time(run.createdAtMs)}
                          </span>
                        </div>
                        {run.error ? (
                          <p className="break-words text-destructive">
                            {run.error}
                          </p>
                        ) : null}
                      </td>
                      <td
                        className={`text-right ${pnlClass(run.metrics?.returnPct ?? null)}`}
                      >
                        {formatSignedPct(run.metrics?.returnPct ?? null)}
                      </td>
                      <td className="text-right">—</td>
                      <td className="hidden text-right sm:table-cell">
                        {formatSignedPct(run.metrics?.maxDrawdownPct ?? null)}
                      </td>
                      <td className="hidden pl-2 text-right sm:table-cell">
                        {time(run.createdAtMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {query?.data ? (
              <HistoryPager
                strategyName={name}
                page={controls.page(group.strategyId)}
                total={query.data.total}
                limit={limit}
                onPage={(page) => controls.setPage(group.strategyId, page)}
              />
            ) : null}
          </HistoryStrategyGroup>
        );
      })}
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
  const navigate = useNavigate();
  const [request, setRequest] = useState<IntradayRequest>(() => {
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
  });
  const clone = useQuery({
    queryKey: ["intraday-run", search.get("clone")],
    queryFn: () =>
      api<IntradayRun>(
        `/intraday/runs/${encodeURIComponent(search.get("clone") ?? "")}`,
      ),
    enabled: !!search.get("clone"),
  });
  const [loadedClone, setLoadedClone] = useState(false);
  if (clone.data && !loadedClone) {
    setRequest(clone.data.request);
    setLoadedClone(true);
  }
  const strategy = getIntradayStrategy(request.strategyId);
  const [validation, setValidation] = useState("");
  const submit = useMutation({
    mutationFn: (body: IntradayRequest) =>
      postJson<IntradayRun>("/intraday/runs", body),
    onSuccess: (run) =>
      void navigate(`/backtests/intraday/${encodeURIComponent(run.id)}`),
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
          clone.error ||
          submit.error ||
          (validation ? new Error(validation) : null)
        }
      />
      <SymbolSearch
        key={loadedClone ? "clone" : "new"}
        value={request.symbol}
        onChange={(symbol) => setRequest((r) => ({ ...r, symbol }))}
      />
      <RangeFields
        min={intradayFirstBacktestDate()}
        from={request.period.from}
        to={request.period.to}
        timeframe={request.timeframe}
        setFrom={(from) =>
          setRequest((r) => ({ ...r, period: { ...r.period, from } }))
        }
        setTo={(to) =>
          setRequest((r) => ({ ...r, period: { ...r.period, to } }))
        }
        setTimeframe={(timeframe) =>
          setRequest(
            (r) =>
              ({
                ...r,
                timeframe,
                parameters:
                  timeframe === "15m" &&
                  r.strategyId === "intraday-ema" &&
                  r.parameters.slow > 24
                    ? {
                        ...r.parameters,
                        slow: 12,
                        fast: Math.min(r.parameters.fast, 11),
                      }
                    : r.parameters,
              }) as IntradayRequest,
          )
        }
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
          <div className="grid gap-3 sm:grid-cols-3">
            {strategy.fields.map((field) => (
              <div key={field.key}>
                {numberField(
                  field.label,
                  (request.parameters as Record<string, number>)[field.key] ??
                    0,
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
        disabled={submit.isPending || (!!search.get("clone") && !loadedClone)}
        onClick={() => {
          const parsed = intradayRequestSchema.safeParse(request);
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
        백테스트 실행
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
      <Chart
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
  const client = useQueryClient();
  const [tab, setTab] = useState<"chart" | "trades">("chart");
  const run = useQuery({
    queryKey: ["intraday-run", id],
    queryFn: () => api<IntradayRun>(`/intraday/runs/${encodeURIComponent(id)}`),
    refetchInterval: (q) =>
      q.state.data && active(q.state.data.status) ? 1000 : false,
  });
  const cancel = useMutation({
    mutationFn: () =>
      api<IntradayRun>(`/intraday/runs/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["intraday-run", id] }),
  });
  const r = run.data;
  const result = r?.result;
  const m = result?.metrics;
  const equityRange = result?.equity.reduce(
    (range, point) => ({
      min: Math.min(range.min, point.equity),
      max: Math.max(range.max, point.equity),
    }),
    { min: Infinity, max: -Infinity },
  );
  return (
    <div className="space-y-4">
      <BacktestHeader mode="intraday" title="백테스트 결과" />
      <ErrorAlert
        error={
          run.error || cancel.error || (r?.error ? new Error(r.error) : null)
        }
      />
      {r && (
        <>
          <p>
            {getIntradayStrategy(r.request.strategyId).name} ·{" "}
            {statusLabel[r.status]} · {r.request.symbol} ·{" "}
            {r.request.period.from} ~ {r.request.period.to}
          </p>
          {active(r.status) && (
            <Button
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              실행 취소
            </Button>
          )}
          <Button asChild variant="outline">
            <Link
              to={`/backtests/intraday/new?clone=${encodeURIComponent(id)}`}
            >
              이 설정으로 다시 실행
            </Link>
          </Button>
        </>
      )}
      {result && m && (
        <>
          <p className="text-xs text-muted-foreground">
            전략 버전 {result.strategyVersion} · {result.request.timeframe} ·{" "}
            {money(result.processedBars)}개 분봉 처리
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {[
              ["손익", `${money(m.pnl)}원`],
              ["수익률", `${money(m.returnPct)}%`],
              ["최대 낙폭", `${money(m.maxDrawdownPct)}%`],
              ["일간 최대 낙폭", `${money(m.dailyMaxDrawdownPct)}%`],
              ["샤프", m.sharpe === null ? "없음" : money(m.sharpe)],
              ["완료 거래", `${m.completedTrades}건`],
              ["비용", `${money(m.totalCosts)}원`],
              [
                "평균 보유",
                m.averageHoldingMinutes === null
                  ? "없음"
                  : `${money(m.averageHoldingMinutes)}분`,
              ],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardContent className="py-3">
                  <p className="text-sm text-muted-foreground">{label}</p>
                  <p>{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          {result.warnings.map((w) => (
            <Alert key={w}>
              <AlertDescription>{w}</AlertDescription>
            </Alert>
          ))}
          {result.position.quantity > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                미청산 수량 {money(result.position.quantity)}주
              </AlertDescription>
            </Alert>
          )}
          <div className="flex gap-2">
            <Button
              variant={tab === "chart" ? "default" : "outline"}
              onClick={() => setTab("chart")}
            >
              차트
            </Button>
            <Button
              variant={tab === "trades" ? "default" : "outline"}
              onClick={() => setTab("trades")}
            >
              체결 및 주문
            </Button>
          </div>
          {tab === "chart" ? (
            <div className="space-y-4">
              <ResultChart
                request={result.request}
                revision={result.dataRevision}
                signals={result.signals}
                fills={result.fills}
              />
              <h3 className="font-semibold">자산 추이</h3>
              {result.equity.length > 0 && (
                <svg
                  viewBox="0 0 800 160"
                  role="img"
                  aria-label="자산 추이 차트"
                  className="w-full rounded border"
                >
                  <polyline
                    fill="none"
                    stroke="currentColor"
                    points={result.equity
                      .map((e, i) => {
                        const min = equityRange?.min ?? 0;
                        const max = equityRange?.max ?? 0;
                        return `${(i * 800) / Math.max(1, result.equity.length - 1)},${150 - ((e.equity - min) / (max - min || 1)) * 140}`;
                      })
                      .join(" ")}
                  />
                </svg>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <h3 className="font-semibold">체결</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th>신호 시각</th>
                      <th>체결 시각</th>
                      <th>방향</th>
                      <th>수량</th>
                      <th>가격</th>
                      <th>비용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.fills.map((f, i) => (
                      <tr
                        key={`${f.orderId}-${i}`}
                        className="border-t text-center"
                      >
                        <td>{time(f.signalAtMs)}</td>
                        <td>{time(f.atMs)}</td>
                        <td>{f.side}</td>
                        <td>{money(f.qty)}</td>
                        <td>{money(f.price)}</td>
                        <td>{money(f.commission + f.tax)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3 className="font-semibold">주문 만료 및 미체결</h3>
              {result.orderEvents.length === 0 ? (
                <p>없음</p>
              ) : (
                result.orderEvents.map((e, i) => (
                  <p key={`${e.orderId}-${i}`} className="text-sm">
                    {time(e.atMs)} · {e.status} · 잔량 {e.remainingQty} ·{" "}
                    {e.reason}
                  </p>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
