import { useMemo, useState } from "react";
import { PageSizeInput, Pagination } from "@/components/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SymbolLabel } from "@/components/symbol-label";
import { parsePageSize } from "@/lib/page-size";
import { summarizeIntradayTrades, type IntradayTrade } from "../../../shared/intraday-trades.js";
import type { IntradayResult } from "../../../shared/schemas/intraday.js";
import { TradesTable } from "../backtests/trades-table";
import { DEFAULT_TRADE_SORT, nextTradeSort, tradeSortSummary, type TradeSort, type TradeSortKey } from "../backtests/trade-sort";

const REASONS: Record<string, string> = {
  EMA: "이동평균", ORB: "시가 범위 돌파", VWAP: "거래량 가중 평균가",
  BOLLINGER_RSI: "볼린저 밴드·RSI", STOP_LOSS: "손절", TAKE_PROFIT: "익절", DAY_EXIT: "장 마감 청산",
};
const STATUSES = { EXPIRED: "만료", CANCELLED: "취소", UNFILLED: "미체결" } as const;
const valueOf = (trade: IntradayTrade, key: TradeSortKey): number => ({
  EXIT_TS: trade.exitTsMs, ENTRY_TS: trade.entryTsMs, QUANTITY: trade.quantity,
  NET_PNL: trade.netPnl, RETURN_PCT: trade.returnPct, HOLDING_TIME: trade.holdingTimeMs,
})[key];
function formatKst(ts: number): string {
  const date = new Date(ts + 9 * 60 * 60_000);
  return `${date.getUTCFullYear()}.${String(date.getUTCMonth() + 1).padStart(2, "0")}.${String(date.getUTCDate()).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function IntradayTradesSection({ result, name }: { result: IntradayResult; name?: string }) {
  const [symbol, setSymbol] = useState("ALL");
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState("10");
  const [sort, setSort] = useState<TradeSort>(DEFAULT_TRADE_SORT);
  const summary = useMemo(() => summarizeIntradayTrades(result), [result]);
  const filtered = useMemo(() => {
    const rows = symbol === "ALL" || symbol === result.request.symbol ? summary.trades : [];
    return [...rows].sort((a, b) => {
      const diff = valueOf(a, sort.key) - valueOf(b, sort.key);
      return (sort.direction === "ASC" ? diff : -diff) || Number(a.id) - Number(b.id);
    });
  }, [result.request.symbol, sort, summary.trades, symbol]);
  const pageSize = parsePageSize(pageSizeText, 10);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const trades = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const openRows = currentPage === 0 && summary.openPosition && (symbol === "ALL" || symbol === summary.openPosition.symbol) ? [summary.openPosition] : [];
  return <Card>
    <CardHeader className="flex flex-row items-center justify-between gap-2">
      <CardTitle className="shrink-0 whitespace-nowrap text-base">거래 내역</CardTitle>
      <Select value={symbol} onValueChange={(value) => { setSymbol(value); setPage(0); }}>
        <SelectTrigger className="h-9 min-w-0 w-56" aria-label="종목 필터"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="ALL">전체 종목</SelectItem><SelectItem value={result.request.symbol}><SymbolLabel symbol={result.request.symbol} name={name ?? null} /></SelectItem></SelectContent>
      </Select>
    </CardHeader>
    <CardContent>
      <div className="mb-2 flex justify-end"><PageSizeInput value={pageSizeText} label="거래 내역 페이지당 표시 수" unit="건" onChange={(value) => { setPageSizeText(value); setPage(0); }} /></div>
      <div data-pagination-content>
        {trades.length || openRows.length ? <>
          <TradesTable trades={trades} openRows={openRows} sort={sort} onSort={(key) => { setSort((current) => nextTradeSort(current, key)); setPage(0); }} nameOf={() => name ?? null} reasonLabel={(reason) => reason ? REASONS[reason] ?? reason : "-"} formatTimestamp={formatKst} formatLastTimestamp={formatKst} />
          <p className="mt-2 text-xs text-muted-foreground">{tradeSortSummary(sort)}으로 정렬했습니다.{openRows.length > 0 ? " 미청산 행은 첫 페이지 맨 위에 고정됩니다." : ""}</p>
        </> : <p className="py-4 text-center text-sm text-muted-foreground">거래가 없습니다.</p>}
      </div>
      <Pagination className="mt-3" ariaLabel="거래 내역 페이지 이동" currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} />
      <div className="mt-4 space-y-1"><h3 className="font-semibold">주문 만료 및 미체결</h3>
        {result.orderEvents.length === 0 ? <p className="text-sm text-muted-foreground">없음</p> : result.orderEvents.map((event, index) => <p key={`${event.orderId}-${index}`} className="text-sm">{formatKst(event.atMs)} · {STATUSES[event.status]} · 잔량 {event.remainingQty} · {event.reason}</p>)}
      </div>
    </CardContent>
  </Card>;
}
