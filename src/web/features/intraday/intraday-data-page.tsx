import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen, Star } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, postJson } from "@/lib/api-client";
import { intradayDate, intradayFirstBacktestDate, intradayRetentionDate, type IntradayChartTimeframe, type IntradayCollection, type IntradayDataOverview } from "../../../shared/schemas/intraday";
import type { SymbolDirectoryEntry, SymbolLibrary } from "../../../shared/schemas/symbol-library";
import { IntradayChartView } from "./intraday-chart";

const timeframes: [IntradayChartTimeframe, string][] = [["1m", "1분"], ["5m", "5분"], ["10m", "10분"], ["15m", "15분"], ["30m", "30분"], ["1h", "1시간"], ["1d", "일"], ["1w", "주"], ["1mo", "월"]];
const time = (ms: number | null) => ms === null ? "없음" : new Date(ms).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const errorText = (error: unknown) => error instanceof Error ? error.message : "요청에 실패했습니다.";

export function IntradayDataPage() {
  const [params, setParams] = useSearchParams();
  const symbol = params.get("symbol") ?? "";
  const [from, setFrom] = useState(intradayRetentionDate());
  const [to, setTo] = useState(intradayDate(Date.now()));
  const [timeframe, setTimeframe] = useState<IntradayChartTimeframe>("5m");
  const [tab, setTab] = useState<"favorites" | "recent">("favorites");
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const tabsId = useId();
  const favoriteTab = useRef<HTMLButtonElement>(null);
  const recentTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [collectFrom, setCollectFrom] = useState(from);
  const [collectTo, setCollectTo] = useState(to);
  const client = useQueryClient();
  const navigate = useNavigate();
  const library = useQuery({ queryKey: ["symbol-library"], queryFn: () => api<SymbolLibrary>("/symbols/library") });
  const searchResults = useQuery({
    queryKey: ["intraday-symbols", debouncedSearch],
    queryFn: () => api<{ symbols: SymbolDirectoryEntry[] }>(`/intraday/symbols?${new URLSearchParams({ q: debouncedSearch })}`),
    enabled: !!debouncedSearch,
  });
  const overview = useQuery({
    queryKey: ["intraday-data"],
    queryFn: () => api<IntradayDataOverview>("/intraday/data"),
    refetchInterval: (q) => q.state.data?.collections.some((c) => ["QUEUED", "RUNNING"].includes(c.status)) ? 1000 : false,
  });
  const updateLibrary = useMutation({
    scope: { id: "symbol-library" },
    mutationFn: ({ code, ...body }: { code: string; favorite?: boolean; viewed?: true }) => api<SymbolLibrary>(`/symbols/library/${encodeURIComponent(code)}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (data) => client.setQueryData(["symbol-library"], data),
  });
  const collect = useMutation({
    mutationFn: () => postJson<IntradayCollection>("/intraday/collections", { symbol, period: { from: collectFrom, to: collectTo } }),
    onSuccess: () => {
      setDialogOpen(false);
      void client.invalidateQueries({ queryKey: ["intraday-data"] });
      void client.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("분봉 데이터 수집을 시작했습니다.", { action: { label: "작업 보기", onClick: () => navigate("/jobs") } });
    },
  });
  const favorites = library.data?.favorites ?? [];
  const searching = !!search.trim();
  const searchPending = searching && (search.trim() !== debouncedSearch || searchResults.isFetching);
  const rows = searching ? (searchPending ? [] : searchResults.data?.symbols ?? []) : library.data?.[tab] ?? [];
  const selected = [...favorites, ...(library.data?.recent ?? []), ...(searchResults.data?.symbols ?? [])].find((entry) => entry.symbol === symbol);
  const stored = overview.data?.symbols.find((entry) => entry.symbol === symbol);
  const selectedFavorite = favorites.some((entry) => entry.symbol === symbol);
  const choose = (entry: SymbolDirectoryEntry) => {
    const next = new URLSearchParams(params);
    next.set("symbol", entry.symbol);
    setParams(next, { replace: true });
    setSearch("");
    updateLibrary.mutate({ code: entry.symbol, viewed: true });
  };
  const quickRange = (days: number) => {
    const end = intradayDate(Date.now());
    const start = intradayDate(Date.parse(`${end}T00:00:00+09:00`) - (days - 1) * 86_400_000);
    setFrom(start < intradayRetentionDate() ? intradayRetentionDate() : start);
    setTo(end);
  };
  const yesterday = intradayDate(Date.now() - 86_400_000);
  const switchTab = (next: "favorites" | "recent") => {
    setTab(next);
    (next === "favorites" ? favoriteTab : recentTab).current?.focus();
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-xl font-semibold">분봉 시세</h3><p className="text-sm text-muted-foreground">관심 종목의 움직임을 원하는 주기로 살펴보세요.</p></div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link to={`/backtests/intraday/new?${new URLSearchParams({ symbol, from: from < intradayFirstBacktestDate() ? intradayFirstBacktestDate() : from, to: to > yesterday ? yesterday : to })}`}>이 조건으로 백테스트</Link></Button>
          <Button disabled={!/^\d{6}$/.test(symbol)} onClick={() => { setCollectFrom(from); setCollectTo(to); collect.reset(); setDialogOpen(true); }}>데이터 수집</Button>
        </div>
      </div>
      {overview.error && <Alert variant="destructive"><AlertDescription>{errorText(overview.error)}</AlertDescription></Alert>}
      {overview.data && !overview.data.configured && <Alert variant="destructive"><AlertDescription>시세 수집을 사용할 수 없습니다. 연결 설정을 확인하세요.</AlertDescription></Alert>}
      <div className={`flex gap-4 ${collapsed ? "flex-row items-start" : "flex-col md:flex-row md:items-stretch"}`}>
        <aside className={collapsed ? "w-12 shrink-0 border-r pr-2" : "w-full shrink-0 border-b pb-3 md:w-60 md:border-r md:border-b-0 md:pr-3 md:pb-0"} aria-label="종목 검색 및 목록">
          {collapsed ? <Button variant="ghost" size="icon" aria-label="종목 패널 열기" onClick={() => setCollapsed(false)}><PanelLeftOpen /></Button> : <>
            <div className="flex items-center justify-between gap-1 py-2">
              <div role="tablist" aria-label="종목 목록" className="flex min-w-0 gap-3 text-sm">
                <button ref={favoriteTab} id={`${tabsId}-favorites-tab`} role="tab" aria-controls={`${tabsId}-favorites-panel`} aria-selected={tab === "favorites"} tabIndex={tab === "favorites" ? 0 : -1} className={tab === "favorites" ? "font-semibold text-foreground" : "text-muted-foreground"} onClick={() => setTab("favorites")} onKeyDown={(e) => { if (["ArrowRight", "ArrowLeft", "End"].includes(e.key)) { e.preventDefault(); switchTab("recent"); } }}>관심 종목</button>
                <button ref={recentTab} id={`${tabsId}-recent-tab`} role="tab" aria-controls={`${tabsId}-recent-panel`} aria-selected={tab === "recent"} tabIndex={tab === "recent" ? 0 : -1} className={tab === "recent" ? "font-semibold text-foreground" : "text-muted-foreground"} onClick={() => setTab("recent")} onKeyDown={(e) => { if (["ArrowRight", "ArrowLeft", "Home"].includes(e.key)) { e.preventDefault(); switchTab("favorites"); } }}>최근 조회 종목</button>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="종목 패널 접기" onClick={() => setCollapsed(true)}><PanelLeftClose /></Button>
            </div>
            <div className="p-3"><Input aria-label="종목 검색 (이름 또는 6자리 코드)" placeholder="종목명 또는 종목 코드 검색" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            {(library.error || searchResults.error || updateLibrary.error) && <p role="alert" className="px-3 pb-2 text-sm text-destructive">{errorText(library.error || searchResults.error || updateLibrary.error)}</p>}
            <div id={`${tabsId}-${tab}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}-tab`} className="max-h-96 overflow-y-auto pb-2">
              {rows.map((entry) => {
                const starred = favorites.some((favorite) => favorite.symbol === entry.symbol);
                return <div key={entry.symbol} className={`flex items-center rounded-md ${symbol === entry.symbol ? "bg-muted" : "hover:bg-muted/50"}`}>
                  <button className="min-w-0 flex-1 px-3 py-2 text-left" onClick={() => choose(entry)}><span className="block truncate text-sm font-medium">{entry.name}</span><span className="text-xs text-muted-foreground">{entry.symbol}{entry.market ? ` · ${entry.market}` : ""}</span></button>
                  <Button variant="ghost" size="icon-sm" disabled={updateLibrary.isPending} aria-label={`${entry.name} 관심 종목 ${starred ? "해제" : "추가"}`} aria-pressed={starred} onClick={() => updateLibrary.mutate({ code: entry.symbol, favorite: !starred })}><Star className={starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground"} /></Button>
                </div>;
              })}
              {rows.length === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">{searchPending || (!searching && library.isLoading) ? "불러오는 중…" : searching ? "검색 결과가 없습니다." : tab === "favorites" ? "관심 종목이 없습니다." : "최근 조회 종목이 없습니다."}</p>}
            </div>
            <div id={`${tabsId}-${tab === "favorites" ? "recent" : "favorites"}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab === "favorites" ? "recent" : "favorites"}-tab`} hidden />
          </>}
        </aside>
        <section className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h4 className="text-lg font-semibold">{selected?.name ?? (symbol || "종목을 선택하세요")}</h4>{symbol && <p className="text-sm text-muted-foreground">{symbol}{selected?.market ? ` · ${selected.market}` : ""}</p>}</div>
            {symbol && <Button variant="ghost" size="sm" disabled={updateLibrary.isPending} aria-pressed={selectedFavorite} onClick={() => updateLibrary.mutate({ code: symbol, favorite: !selectedFavorite })}><Star className={selectedFavorite ? "fill-amber-400 text-amber-400" : ""} />{selectedFavorite ? "관심 종목 해제" : "관심 종목 추가"}</Button>}
          </div>
          <div className="flex flex-wrap gap-1" aria-label="봉 주기">{timeframes.map(([value, label]) => <Button key={value} variant={timeframe === value ? "secondary" : "ghost"} size="sm" aria-pressed={timeframe === value} onClick={() => setTimeframe(value)}>{label}</Button>)}</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs text-muted-foreground">시작일<Input type="date" min={intradayRetentionDate()} max={intradayDate(Date.now())} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="grid gap-1 text-xs text-muted-foreground">종료일<Input type="date" min={intradayRetentionDate()} max={intradayDate(Date.now())} value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <div className="flex flex-wrap gap-1" aria-label="조회 기간">{[[1, "1일"], [7, "1주"], [30, "1개월"], [365, "1년"]].map(([days, label]) => <Button key={days} variant="outline" size="sm" onClick={() => quickRange(Number(days))}>{label}</Button>)}</div>
          </div>
          <IntradayChartView symbol={symbol} from={from} to={to} timeframe={timeframe} refreshRevision={stored?.revision} showSummary />
          <p className="text-xs text-muted-foreground">보관 범위: {stored ? `${time(stored.firstEndMs)} ~ ${time(stored.lastEndMs)} · ${stored.bars.toLocaleString("ko-KR")}개` : "없음"} · 보관된 1분봉 기준 · 09:00–15:20 KST · 수정주가 미적용</p>
        </section>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogContent>
        <DialogHeader><DialogTitle>분봉 데이터 수집</DialogTitle><DialogDescription>{selected?.name ?? symbol} · {symbol}<br />누락된 날짜만 하루 단위로 수집합니다. 완료·실패는 알림과 작업 기록에서 확인하세요.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">시작일<Input type="date" min={intradayRetentionDate()} max={intradayDate(Date.now())} value={collectFrom} onChange={(e) => setCollectFrom(e.target.value)} /></label>
          <label className="grid gap-1">종료일<Input type="date" min={intradayRetentionDate()} max={intradayDate(Date.now())} value={collectTo} onChange={(e) => setCollectTo(e.target.value)} /></label>
        </div>
        {collect.error && <Alert variant="destructive" role="alert"><AlertDescription>{errorText(collect.error)}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" onClick={() => setDialogOpen(false)}>닫기</Button><Button disabled={collect.isPending || !collectFrom || !collectTo || collectFrom > collectTo || collectFrom < intradayRetentionDate() || collectTo > intradayDate(Date.now())} onClick={() => collect.mutate()}>수집 시작</Button></DialogFooter>
      </DialogContent></Dialog>
    </div>
  );
}
