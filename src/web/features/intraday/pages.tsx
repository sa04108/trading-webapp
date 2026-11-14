import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
const defaults = (): IntradayRequest => ({
  mode: "intraday",
  strategyId: "intraday-ema",
  symbol: "",
  period: { from: intradayFirstBacktestDate(), to: yesterday() },
  timeframe: "5m",
  initialCash: 10_000_000,
  parameters: {
    fast: 12,
    slow: 26,
    allocationPct: 95,
    stopLossPct: 3,
    takeProfitPct: 6,
  },
  execution: {
    holdingPolicy: "DAY_ONLY",
    commissionBps: 1.5,
    taxBps: 20,
    slippageBps: 5,
    latencyMs: 1000,
    orderExpiryMinutes: 3,
    maxParticipationPct: 1,
  },
});
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
export function IntradayNav() {
  return (
    <nav aria-label="백테스트 종류" className="flex gap-2">
      <Button asChild variant="outline" size="sm">
        <Link to="/backtests">일봉</Link>
      </Button>
      <Button asChild variant="outline" size="sm">
        <Link to="/backtests/intraday">분봉</Link>
      </Button>
    </nav>
  );
}
export function IntradayListPage() {
  const runs = useQuery({
    queryKey: ["intraday-runs"],
    queryFn: () => api<{ runs: IntradayRun[] }>("/intraday/runs"),
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => active(r.status)) ? 1000 : false,
  });
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">분봉 백테스트</h2>
      <IntradayNav />
      <Button asChild>
        <Link to="/backtests/intraday/new">새 분봉 백테스트</Link>
      </Button>
      <ErrorAlert error={runs.error} />
      {runs.data?.runs.length === 0 && <p>백테스트가 없습니다.</p>}
      {runs.data?.runs.map((run) => (
        <Link
          className="block"
          to={`/backtests/intraday/${encodeURIComponent(run.id)}`}
          key={run.id}
        >
          <Card>
            <CardContent className="space-y-1 py-4">
              <p>
                {statusLabel[run.status]} · {run.request.symbol} ·{" "}
                {run.request.timeframe}
              </p>
              <p className="text-sm text-muted-foreground">
                {run.request.period.from} ~ {run.request.period.to} ·{" "}
                {time(run.createdAtMs)}
              </p>
              {run.error && <p className="text-destructive">{run.error}</p>}
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
export function IntradayNewPage() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [request, setRequest] = useState<IntradayRequest>(() => {
    const d = defaults();
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
  ) => (
    <Field label={label}>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => update(Number(e.target.value))}
      />
    </Field>
  );
  const params = (key: keyof IntradayRequest["parameters"], n: number) =>
    setRequest((r) => ({ ...r, parameters: { ...r.parameters, [key]: n } }));
  const execution = (
    key: Exclude<keyof IntradayRequest["execution"], "holdingPolicy">,
    n: number,
  ) => setRequest((r) => ({ ...r, execution: { ...r.execution, [key]: n } }));
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">새 분봉 백테스트</h2>
      <IntradayNav />
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
          setRequest((r) => ({
            ...r,
            timeframe,
            parameters:
              timeframe === "15m" && r.parameters.slow > 24
                ? {
                    ...r.parameters,
                    slow: 12,
                    fast: Math.min(r.parameters.fast, 11),
                  }
                : r.parameters,
          }))
        }
        max={yesterday()}
      />
      <Card>
        <CardContent className="space-y-3 py-4">
          <h3 className="font-semibold">EMA 교차 전략</h3>
          <p className="text-sm text-muted-foreground">
            매일 EMA를 초기화하고 장기 EMA 기간만큼 준비합니다. 09:00~15:20,
            진입 마감 15:10, 청산 신호 15:15. 청산 미체결 시 보유 상태로 해당
            일에 시뮬레이션을 중단합니다.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {numberField("단기 EMA", request.parameters.fast, (n) =>
              params("fast", n),
            )}
            {numberField("장기 EMA", request.parameters.slow, (n) =>
              params("slow", n),
            )}
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
      <h2 className="text-lg font-semibold">분봉 백테스트 결과</h2>
      <IntradayNav />
      <ErrorAlert
        error={
          run.error || cancel.error || (r?.error ? new Error(r.error) : null)
        }
      />
      {r && (
        <>
          <p>
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
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
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
