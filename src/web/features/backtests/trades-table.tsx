import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SymbolLabel } from "@/components/symbol-label";
import { formatDate, formatDateTime, formatDuration, formatKrw, formatSignedKrw, formatSignedPct, pnlClass } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ariaSortValue, TRADE_SORT_LABELS, tradeSortHint, type TradeSort, type TradeSortKey } from "./trade-sort";
import type { OpenPositionRow } from "./open-position-rows";
import { staleDays } from "./stale-days";

interface TradeRow {
  id: string | number; symbol: string; quantity: number; entryTsMs: number; exitTsMs: number;
  entryPrice: number; exitPrice: number; costs: number; netPnl: number; returnPct: number;
  holdingTimeMs: number; exitReason: string | null;
}
type OpenRow = OpenPositionRow & { entryCosts?: number };

function SortableHead({ sortKey, sort, onSort, align, secondary }: {
  sortKey: TradeSortKey; sort: TradeSort; onSort: (key: TradeSortKey) => void;
  align?: "right"; secondary?: string;
}) {
  const active = sort.key === sortKey;
  return <TableHead aria-sort={ariaSortValue(sort, sortKey)} className={align === "right" ? "text-right" : undefined}>
    <Button variant="ghost" size="xs" className="-mx-2 font-medium" title={tradeSortHint(sort, sortKey)} onClick={() => onSort(sortKey)}>
      {TRADE_SORT_LABELS[sortKey]}{sortKey === "NET_PNL" ? " (원)" : ""}
      {active ? sort.direction === "ASC" ? <ArrowUp /> : <ArrowDown /> : <ChevronsUpDown className="opacity-40" />}
    </Button>
    {secondary && <div className="text-xs text-muted-foreground">{secondary}</div>}
  </TableHead>;
}

export function TradesTable({ trades, openRows, sort, onSort, nameOf, reasonLabel, formatTimestamp = formatDateTime, formatLastTimestamp = formatDate, periodEndMs }: {
  trades: readonly TradeRow[]; openRows: readonly OpenRow[]; sort: TradeSort; onSort: (key: TradeSortKey) => void;
  nameOf: (symbol: string) => string | null; reasonLabel: (reason: string | null) => string;
  formatTimestamp?: (ts: number) => string; formatLastTimestamp?: (ts: number) => string; periodEndMs?: number;
}) {
  return <div className="overflow-x-auto"><Table><TableHeader><TableRow>
    <TableHead>종목</TableHead>
    <SortableHead sortKey="QUANTITY" sort={sort} onSort={onSort} align="right" />
    <SortableHead sortKey="ENTRY_TS" sort={sort} onSort={onSort} secondary="진입가 (원)" />
    <SortableHead sortKey="EXIT_TS" sort={sort} onSort={onSort} secondary="매도가 (원)" />
    <SortableHead sortKey="NET_PNL" sort={sort} onSort={onSort} align="right" />
    <TableHead className="text-right">비용 (원)</TableHead>
    <SortableHead sortKey="RETURN_PCT" sort={sort} onSort={onSort} align="right" />
    <SortableHead sortKey="HOLDING_TIME" sort={sort} onSort={onSort} />
    <TableHead>마지막 확인일</TableHead><TableHead>사유</TableHead>
  </TableRow></TableHeader><TableBody>
    {openRows.map((row) => {
      const stale = periodEndMs === undefined ? 0 : staleDays(row.lastPriceTsMs, periodEndMs);
      return <TableRow key={`open-${row.symbol}`} className="bg-muted/40">
        <TableCell className="font-medium"><SymbolLabel symbol={row.symbol} name={nameOf(row.symbol)} /></TableCell>
        <TableCell className="text-right tabular-nums">{row.quantity}</TableCell>
        <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(row.entryTsMs)}<br /><span className="text-muted-foreground">{formatKrw(row.entryPrice)}</span></TableCell>
        <TableCell className="whitespace-nowrap text-xs"><Badge variant="outline">미청산</Badge><br /><span className="text-muted-foreground">{formatKrw(row.lastPrice)}</span></TableCell>
        <TableCell className={cn("text-right tabular-nums", pnlClass(row.unrealizedPnl))}>{formatSignedKrw(row.unrealizedPnl)}</TableCell>
        <TableCell className="text-right tabular-nums">{row.entryCosts === undefined ? "-" : formatKrw(row.entryCosts)}</TableCell>
        <TableCell className={cn("text-right tabular-nums", pnlClass(row.returnPct))}>{formatSignedPct(row.returnPct)}</TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDuration(row.holdingTimeMs)}</TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatLastTimestamp(row.lastPriceTsMs)}{stale > 0 ? ` (${stale}일 경과)` : ""}</TableCell>
        <TableCell className="text-xs text-muted-foreground">미청산</TableCell>
      </TableRow>;
    })}
    {trades.map((trade) => <TableRow key={trade.id}>
      <TableCell className="font-medium"><SymbolLabel symbol={trade.symbol} name={nameOf(trade.symbol)} /></TableCell>
      <TableCell className="text-right tabular-nums">{trade.quantity}</TableCell>
      <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(trade.entryTsMs)}<br /><span className="text-muted-foreground">{formatKrw(trade.entryPrice)}</span></TableCell>
      <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(trade.exitTsMs)}<br /><span className="text-muted-foreground">{formatKrw(trade.exitPrice)}</span></TableCell>
      <TableCell className={cn("text-right tabular-nums", pnlClass(trade.netPnl))}>{formatSignedKrw(trade.netPnl)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatKrw(trade.costs)}</TableCell>
      <TableCell className={cn("text-right tabular-nums", pnlClass(trade.returnPct))}>{formatSignedPct(trade.returnPct)}</TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDuration(trade.holdingTimeMs)}</TableCell>
      <TableCell className="text-xs text-muted-foreground">-</TableCell>
      <TableCell className="text-xs text-muted-foreground">{reasonLabel(trade.exitReason)}</TableCell>
    </TableRow>)}
  </TableBody></Table></div>;
}
