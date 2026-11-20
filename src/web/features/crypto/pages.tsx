import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { EquityChart } from "@/features/backtests/result-charts";
import { Pagination } from "@/components/pagination";
import { cryptoBacktestInputSchema, type CryptoBacktestInput } from "@shared/crypto-backtest";
import type { CryptoRunDetail, CryptoRunSummary } from "@shared/crypto-runs";
import { api, postJson } from "@/lib/api-client";
import { BacktestHeader } from "@/features/backtests/backtest-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DAY = 86_400_000;
const latestDay = () => new Date(Math.floor(Date.now() / DAY) * DAY - DAY).toISOString().slice(0, 10);
const active = (status: string) => ["COLLECTING", "QUEUED", "RUNNING"].includes(status);
const statusLabel: Record<string, string> = {
  COLLECTING: "데이터 수집 중",
  QUEUED: "대기 중",
  RUNNING: "실행 중",
  COMPLETED: "완료",
  FAILED: "실패",
  CANCELLED: "취소됨",
};
const money = (value: number) => `${value.toLocaleString("ko-KR", { maximumFractionDigits: 8 })}원`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : "요청에 실패했습니다.");

function initialInput(): CryptoBacktestInput {
  const endDate = latestDay();
  return {
    markets: ["KRW-BTC", "KRW-ETH", "KRW-XRP"],
    startDate: new Date(Date.parse(`${endDate}T00:00:00Z`) - 364 * DAY).toISOString().slice(0, 10),
    endDate,
    initialCash: 10_000_000,
    universeSize: 3,
    lookbackDays: 30,
    feeBps: 5,
    slippageBps: 5,
  };
}

export function CryptoBacktestsPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState(initialInput);
  const [custom, setCustom] = useState("");
  const [marketSearch, setMarketSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const markets = useQuery({
    queryKey: ["crypto", "markets"],
    queryFn: ({ signal }) =>
      api<{ markets: { market: string; name: string }[] }>("/crypto/markets", { signal }),
  });
  const runs = useQuery({
    queryKey: ["crypto", "backtests", offset],
    queryFn: ({ signal }) =>
      api<{ runs: CryptoRunSummary[]; total: number }>(`/crypto/backtests?limit=30&offset=${offset}`, {
        signal,
      }),
    refetchInterval: (query) => (query.state.data?.runs.some((run) => active(run.status)) ? 3000 : false),
  });
  const submit = useMutation({
    mutationFn: (body: CryptoBacktestInput) => postJson<{ id: string }>("/crypto/backtests", body),
    onSuccess: ({ id }) => void navigate(`/backtests/crypto/${encodeURIComponent(id)}`),
  });
  const parsed = cryptoBacktestInputSchema.safeParse(input);
  const validDates = input.endDate <= latestDay();
  const toggleMarket = (market: string) =>
    setInput((old) => ({
      ...old,
      markets: old.markets.includes(market)
        ? old.markets.filter((item) => item !== market)
        : [...old.markets, market],
    }));
  const addCustom = () => {
    const market = custom.trim().toUpperCase();
    if (market && !input.markets.includes(market))
      setInput((old) => ({ ...old, markets: [...old.markets, market] }));
    setCustom("");
  };
  return (
    <div className="space-y-6">
      <BacktestHeader mode="crypto" />
      <Card>
        <CardHeader>
          <CardTitle>코인 일봉 백테스트</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            업비트 원화 마켓의 확정된 UTC 일봉을 사용합니다. UTC 일봉 시작은 한국 시간 오전 9시입니다. 최근
            30일 평균 거래대금으로 유니버스를 정하고, 양의 모멘텀이 가장 강한 마켓을 다음 일봉 시가에
            매수합니다.
          </p>
          <p className="text-sm text-muted-foreground">
            현재 마켓을 과거 후보로 쓰면 상장 폐지된 마켓이 빠지는 생존 편향이 있습니다. 스테이킹 등 보상은
            수익에 포함하지 않습니다. 후보는 직접 수정할 수 있습니다.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="시작일">
              <Input
                type="date"
                value={input.startDate}
                max={latestDay()}
                onChange={(e) => setInput({ ...input, startDate: e.target.value })}
              />
            </Field>
            <Field label="종료일">
              <Input
                type="date"
                value={input.endDate}
                max={latestDay()}
                onChange={(e) => setInput({ ...input, endDate: e.target.value })}
              />
            </Field>
            <NumberField
              label="초기 자금 (원)"
              value={input.initialCash}
              min={1}
              onChange={(value) => setInput({ ...input, initialCash: value })}
            />
            <NumberField
              label="유니버스 크기"
              value={input.universeSize}
              min={1}
              max={40}
              onChange={(value) => setInput({ ...input, universeSize: value })}
            />
            <NumberField
              label="모멘텀 조회 일수"
              value={input.lookbackDays}
              min={1}
              max={365}
              onChange={(value) => setInput({ ...input, lookbackDays: value })}
            />
            <NumberField
              label="수수료 (bp)"
              value={input.feeBps}
              min={0}
              max={9999}
              onChange={(value) => setInput({ ...input, feeBps: value })}
            />
            <NumberField
              label="슬리피지 (bp)"
              value={input.slippageBps}
              min={0}
              max={9999}
              onChange={(value) => setInput({ ...input, slippageBps: value })}
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">선택된 후보 ({input.markets.length}/40)</p>
            <div className="flex flex-wrap gap-2">
              {input.markets.map((market) => (
                <Button
                  key={market}
                  size="sm"
                  variant="secondary"
                  onClick={() => toggleMarket(market)}
                  aria-label={`${market} 제거`}
                >
                  {market} ×
                </Button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="직접 마켓 추가"
              placeholder="KRW-BTC"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
            />
            <Button variant="outline" onClick={addCustom}>
              추가
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer text-sm">현재 업비트 원화 마켓에서 선택</summary>
            <Input
              className="mt-2"
              aria-label="마켓 검색"
              placeholder="이름 또는 마켓 검색"
              value={marketSearch}
              onChange={(e) => setMarketSearch(e.target.value)}
            />
            {markets.isError ? (
              <p role="alert" className="text-sm text-destructive">
                마켓 조회 실패: {errorText(markets.error)}
              </p>
            ) : markets.isPending ? (
              <p>마켓 조회 중...</p>
            ) : (
              <div className="mt-2 grid max-h-56 grid-cols-2 gap-2 overflow-auto sm:grid-cols-3">
                {markets.data.markets
                  .filter(({ market, name }) =>
                    `${market} ${name}`.toLowerCase().includes(marketSearch.trim().toLowerCase()),
                  )
                  .map(({ market, name }) => (
                    <label key={market} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={input.markets.includes(market)}
                        disabled={!input.markets.includes(market) && input.markets.length >= 40}
                        onChange={() => toggleMarket(market)}
                      />
                      {name} ({market})
                    </label>
                  ))}
              </div>
            )}
          </details>
          {!parsed.success && (
            <p role="alert" className="text-sm text-destructive">
              {parsed.error.issues[0]?.message}
            </p>
          )}
          {!validDates && (
            <p role="alert" className="text-sm text-destructive">
              종료일은 완료된 UTC 일봉이어야 합니다.
            </p>
          )}
          <p className="text-sm text-muted-foreground">기간은 최대 366일, 후보는 최대 40개입니다.</p>
          {submit.isError && (
            <p role="alert" className="text-sm text-destructive">
              실행 요청 실패: {errorText(submit.error)}
            </p>
          )}
          <Button
            disabled={!parsed.success || !validDates || submit.isPending}
            onClick={() => {
              if (parsed.success) submit.mutate(parsed.data);
            }}
          >
            {submit.isPending ? "요청 중..." : "백테스트 실행"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>실행 기록</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {runs.isError && (
            <p role="alert" className="text-destructive">
              실행 기록 조회 실패: {errorText(runs.error)}
            </p>
          )}
          {runs.isPending && <p>조회 중...</p>}
          {runs.data?.runs.length === 0 && <p>실행 기록이 없습니다.</p>}
          {runs.data?.runs.map((run) => (
            <Link
              className="block rounded-md border p-3 hover:bg-muted"
              key={run.id}
              to={`/backtests/crypto/${encodeURIComponent(run.id)}`}
            >
              <div className="flex flex-wrap justify-between gap-2">
                <span>
                  {run.input.startDate} ~ {run.input.endDate}
                </span>
                {run.status !== "COMPLETED" && <span>{statusLabel[run.status] ?? run.status}</span>}
              </div>
              <p className="text-sm text-muted-foreground">
                {run.input.markets.join(", ")} · {new Date(run.createdAtMs).toLocaleString("ko-KR")}
              </p>
              {run.error && <p className="text-sm text-destructive">{run.error}</p>}
            </Link>
          ))}
          {runs.data && runs.data.total > 30 && (
            <Pagination
              ariaLabel="코인 실행 기록 페이지"
              currentPage={Math.floor(offset / 30)}
              pageCount={Math.ceil(runs.data.total / 30)}
              pending={runs.isFetching}
              onPageChange={(page) => setOffset(page * 30)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Label className="grid gap-2">
      {label}
      {children}
    </Label>
  );
}
function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        min={min}
        max={max}
        value={Number.isNaN(value) ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      />
    </Field>
  );
}

export function CryptoBacktestDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [cancelRequested, setCancelRequested] = useState(false);
  const path = `/crypto/backtests/${encodeURIComponent(id)}`;
  const detail = useQuery({
    queryKey: ["crypto", "backtest", id],
    queryFn: ({ signal }) => api<CryptoRunDetail>(path, { signal }),
    refetchInterval: (query) => (!query.state.data || active(query.state.data.status) ? 3000 : false),
  });
  const cancel = useMutation({
    mutationFn: () => api<void>(path, { method: "DELETE" }),
    onSuccess: async () => {
      setCancelRequested(true);
      await client.invalidateQueries({ queryKey: ["crypto", "backtest", id] });
    },
  });
  const run = detail.data;
  const result = run?.result;
  return (
    <div className="space-y-6">
      <BacktestHeader mode="crypto" />
      <Link className="text-sm underline" to="/backtests/crypto">
        ← 코인 일봉 목록
      </Link>
      {detail.isError && (
        <p role="alert" className="text-destructive">
          실행 조회 실패: {errorText(detail.error)}
        </p>
      )}
      {detail.isPending && <p>조회 중...</p>}
      {run && (
        <Card>
          <CardHeader>
            <CardTitle>거래대금 상위 모멘텀</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {run.input.startDate} ~ {run.input.endDate} · 후보 {run.input.markets.length}개
            </p>
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">재현 정보</summary>
              <div className="mt-2 space-y-1 break-all">
                <p>
                  실행 ID: {run.id} · 전략 버전: {run.strategyVersion}
                  {run.datasetHash ? ` · 데이터: ${run.datasetHash.slice(0, 16)}…` : ""}
                </p>
                <p>후보: {run.input.markets.join(", ")}</p>
                <p>
                  초기 자금: {money(run.input.initialCash)} · 유니버스: {run.input.universeSize}개 · 모멘텀:{" "}
                  {run.input.lookbackDays}일 · 수수료: {run.input.feeBps}bp · 슬리피지:{" "}
                  {run.input.slippageBps}bp
                </p>
              </div>
            </details>
            {active(run.status) && <p>{statusLabel[run.status]}</p>}
            {!active(run.status) && run.status !== "COMPLETED" && (
              <p>{statusLabel[run.status] ?? run.status}</p>
            )}
            {run.error && (
              <p role="alert" className="text-destructive">
                {run.error}
              </p>
            )}
            {cancel.isError && (
              <p role="alert" className="text-destructive">
                취소 실패: {errorText(cancel.error)}
              </p>
            )}
            {active(run.status) && (
              <Button
                variant="outline"
                disabled={cancel.isPending || cancelRequested}
                onClick={() => cancel.mutate()}
              >
                {cancelRequested ? "취소 요청됨" : "실행 취소"}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      {result && run?.status === "COMPLETED" && (
        <Button
          variant="outline"
          onClick={() => void navigate(`/trading/crypto?source=${encodeURIComponent(run.id)}`)}
        >
          이 설정으로 매매 준비
        </Button>
      )}
      {result && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              label="총 수익률"
              value={`${(result.totalReturn * 100).toFixed(2)}%`}
              tone={result.totalReturn > 0 ? "profit" : result.totalReturn < 0 ? "loss" : undefined}
            />
            <Metric
              label="MDD"
              value={`${(-result.maxDrawdown * 100 || 0).toFixed(2)}%`}
              tone={result.maxDrawdown > 0 ? "loss" : undefined}
            />
            <Metric label="최종 자산" value={money(result.finalEquity)} />
          </div>
          {result.warnings.map((warning, index) => (
            <p key={index} className="text-sm text-destructive">
              {warning}
            </p>
          ))}
          <EquityChart
            points={result.equityCurve.map((point) => ({
              tsMs: Date.parse(point.date),
              value: point.equity,
            }))}
            summary={`일봉 종가 평가 · ${result.equityCurve.length}일`}
          />
          <Card>
            <CardHeader>
              <CardTitle>거래 내역</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th>일자</th>
                      <th>마켓</th>
                      <th>구분</th>
                      <th>수량</th>
                      <th>가격</th>
                      <th>수수료</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((trade, index) => (
                      <tr key={index} className="border-b">
                        <td>{trade.date}</td>
                        <td>{trade.market}</td>
                        <td>{trade.side === "BUY" ? "매수" : "매도"}</td>
                        <td>{trade.quantity.toLocaleString("ko-KR", { maximumFractionDigits: 8 })}</td>
                        <td>{money(trade.price)}</td>
                        <td>{money(trade.fee)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.trades.length === 0 && <p className="py-3">거래 내역이 없습니다.</p>}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
function Metric({ label, value, tone }: { label: string; value: string; tone?: "profit" | "loss" }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p
          className={`text-xl font-semibold ${tone === "profit" ? "text-gain" : tone === "loss" ? "text-loss" : ""}`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
