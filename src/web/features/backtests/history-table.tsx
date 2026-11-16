import type { ReactNode } from "react";
import { InfoHint } from "@/components/info-hint";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatSignedPct, pnlClass } from "@/lib/format";
import type { HistoryView } from "./history-controls";
import { HISTORY_TABLE_COLUMNS, type HistoryColumnId } from "./history-table-preferences";
import "./history-table.css";

export function HistoryLayout({ columns, view, children }: {
  columns: readonly HistoryColumnId[];
  view: HistoryView;
  children: ReactNode;
}) {
  return (
    <div
      className={`grid min-w-0 max-w-full gap-y-4 ${view === "table" ? "history-table-layout isolate" : ""}`}
      style={view === "table" ? { gridTemplateColumns: `repeat(${columns.length + 1}, auto)` } : undefined}
      role={view === "table" ? "region" : undefined}
      aria-label={view === "table" ? "백테스트 이력" : undefined}
      tabIndex={view === "table" ? 0 : undefined}
    >
      {children}
    </div>
  );
}

export function HistoryTable({ columns, busy, children }: {
  columns: readonly HistoryColumnId[];
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Table data-pagination-content aria-busy={busy} className="text-xs [&_td]:px-1 [&_th]:px-1">
      <TableHeader>
        <TableRow className="bg-muted/50">
          <TableHead className="sticky left-0 z-10 bg-background text-muted-foreground">기간</TableHead>
          {columns.map((id) => (
            <TableHead key={id} className="text-right text-muted-foreground">
              {HISTORY_TABLE_COLUMNS.find((column) => column.id === id)!.label}
              {id === "seed" ? <InfoHint label="난수 시드 통계 설명">건수는 난수 시드 실험 수이며 괄호는 완료된 실행 중 유효한 수익률의 표본 표준편차입니다.</InfoHint> : null}
              {id === "validation" ? <InfoHint label="기간 검증 통계 설명">건수는 기간 검증 실험 수이며 괄호는 모든 OOS 회차가 평가된 완료 실험별 OOS 평균 수익률 분포의 표본 표준편차입니다.</InfoHint> : null}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

export type HistoryTableValues = {
  return?: number | null;
  cagr?: number | null;
  mdd?: number | null;
  date: number;
  sharpe?: number | null;
  seed?: { count: number; stddev: number | null };
  validation?: { count: number; stddev: number | null };
};

export function HistoryMetricCells({ columns, values }: {
  columns: readonly HistoryColumnId[];
  values: HistoryTableValues;
}) {
  return columns.map((id) => {
    if (id === "date") return <TableCell key={id} className="text-right text-muted-foreground tabular-nums">{formatDateTime(values.date)}</TableCell>;
    if (id === "seed" || id === "validation") {
      const stats = values[id];
      return <TableCell key={id} className="text-right tabular-nums">{stats === undefined ? "—" : `${stats.count} (${stats.stddev == null ? "—" : `${stats.stddev.toFixed(2)}%p`})`}</TableCell>;
    }
    if (id === "sharpe") {
      const value = values.sharpe;
      return <TableCell key={id} className={`text-right tabular-nums ${value == null ? "text-muted-foreground" : value < 0 ? "text-loss" : value >= 1 ? "text-gain" : "text-foreground"}`}>{value == null ? "—" : value.toFixed(2)}</TableCell>;
    }
    return <TableCell key={id} className={`text-right tabular-nums ${pnlClass(values[id])}`}>{formatSignedPct(values[id] ?? null)}</TableCell>;
  });
}
