import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDateTime, formatSignedPct, pnlClass } from "@/lib/format";
import type { BacktestHistoryExtras } from "@shared/schemas/backtest-experiments";
import { ExperimentLinks, hasExperimentRecords } from "./experiment-links";
import type { ExperimentMode } from "./experiment-paths";

export function HistoryResultDetails({ id, status, description, summary, mode, editing }: {
  id: string;
  status?: ReactNode;
  description?: ReactNode;
  summary?: BacktestHistoryExtras;
  mode?: ExperimentMode;
  editing: boolean;
}) {
  if (!status && !description && (editing || !hasExperimentRecords(summary))) return null;
  return (
    <div className="mt-1 flex items-center gap-1 text-muted-foreground">
      {status}{description}
      {!editing ? <ExperimentLinks jobId={id} summary={summary} mode={mode} /> : null}
    </div>
  );
}

export function HistoryResultCard({
  id, href, period, date, description, status, summary, mode = "daily",
  editing, selected, deletable, selectionDisabled, onToggle, progress, metrics, error,
}: {
  id: string;
  href: string;
  period: string;
  date: number;
  description: string;
  status: ReactNode;
  summary?: BacktestHistoryExtras;
  mode?: ExperimentMode;
  editing: boolean;
  selected: boolean;
  deletable: boolean;
  selectionDisabled?: boolean;
  onToggle: () => void;
  progress?: ReactNode;
  metrics?: { returnPct: number | null; cagrPct: number | null; mddPct: number | null; trades?: number };
  error?: string | null;
}) {
  const card = (
    <Card className="relative transition-colors hover:bg-muted/40">
      <CardContent className="space-y-2 py-4">
        {status || (!editing && hasExperimentRecords(summary)) ? (
          <div className="flex items-start justify-between gap-2">
            {status}
            {!editing ? <ExperimentLinks jobId={id} summary={summary} mode={mode} /> : null}
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-2 whitespace-nowrap">
          {editing ? <p className="text-xs font-medium">{period}</p> : (
            <Link className="text-xs font-medium underline after:absolute after:inset-0" to={href}>{period}</Link>
          )}
          <time className="shrink-0 text-[11px] text-muted-foreground tabular-nums" dateTime={new Date(date).toISOString()} title={formatDateTime(date)}>
            {formatDateTime(date).replace(/^\d{2}/, "")}
          </time>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
        {progress}
        {metrics ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {[{ label: "수익률", value: metrics.returnPct }, { label: "CAGR", value: metrics.cagrPct }].map(({ label, value }) => (
                <div key={label}>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`text-xl font-semibold tabular-nums ${pnlClass(value)}`}>{formatSignedPct(value)}</p>
                </div>
              ))}
            </div>
            <div className="flex justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
              <span>MDD <span className={pnlClass(metrics.mddPct)}>{formatSignedPct(metrics.mddPct)}</span></span>
              {metrics.trades !== undefined ? <span>매도 체결 {metrics.trades}건</span> : null}
            </div>
          </div>
        ) : null}
        {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
  if (!editing) return card;
  if (!deletable) return (
    <div className="flex items-start gap-3">
      <span className="mt-5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">{card}</div>
    </div>
  );
  const checkboxId = `${mode}-backtest-${id}`;
  return (
    <div className="flex items-start gap-3">
      <Checkbox id={checkboxId} checked={selected} disabled={selectionDisabled} onCheckedChange={onToggle}
        aria-label={`${formatDateTime(date)} 백테스트 선택`} className="mt-5" />
      <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">{card}</label>
    </div>
  );
}
