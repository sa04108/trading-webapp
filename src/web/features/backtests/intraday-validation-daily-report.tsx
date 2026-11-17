import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { InfoHint } from "@/components/info-hint";
import { chartTooltipProps } from "@/components/chart-tooltip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api-client";
import { formatKrw, formatNumber, formatSignedPct, pnlClass, sharpeClass } from "@/lib/format";
import type { IntradayDailyReport, IntradayDailySummary } from "@shared/schemas/intraday-daily";
import { getValidationOptimization, type PeriodValidationDto, type ValidationTrialDto } from "@shared/schemas/period-validation";
import { experimentPaths } from "./experiment-paths";

const pct = (value: number | null | undefined) => value == null ? "—" : formatSignedPct(value);
const proportion = (value: number | null | undefined) => value == null ? "—" : `${formatNumber(value)}%`;
const num = (value: number | null | undefined) => value == null ? "—" : formatNumber(value);
const statuses: Record<string, string> = {
  COMPLETE: "정상 평가", PARTIAL: "부분 시세", MISSING: "시세 누락", EXIT_FAILED: "청산 실패", NOT_RUN: "미실행",
};
const axisTick = { fontSize: 11, fill: "var(--muted-foreground)" } as const;

function quality(s: IntradayDailySummary) {
  return [
    s.partialDays && `부분 시세 ${s.partialDays}일`,
    s.missingDays && `시세 누락 ${s.missingDays}일`,
    s.exitFailedDays && `청산 실패 ${s.exitFailedDays}일`,
    s.notRunDays && `미실행 ${s.notRunDays}일`,
  ].filter(Boolean).join(" · ") || "전체 기간 평가";
}

function resultLink(trial: ValidationTrialDto | undefined, text: string) {
  return trial?.jobId ? (
    <Link className="underline underline-offset-4" to={experimentPaths("intraday").result(trial.jobId)}>{text}</Link>
  ) : text;
}

function unavailableMessage(trial: ValidationTrialDto | undefined, legacy: boolean) {
  if (legacy) return "이 기록에는 일별 관측 정보가 저장되지 않았습니다. 기존 결과 링크에서 실행 결과를 확인할 수 있습니다.";
  if (trial?.status === "NOT_EVALUATED") return "선택 후보가 없어 미평가되었습니다.";
  if (trial?.status === "SKIPPED") return "이 구간은 실행되지 않았습니다.";
  if (["FAILED", "CANCELLED", "INTERRUPTED"].includes(trial?.status ?? "")) return "실행이 완료되지 않아 일별 보고서가 없습니다.";
  return "이 구간은 실행 대기 또는 진행 중입니다.";
}

export function IntradayValidationDailyReport({ experiment }: { experiment: PeriodValidationDto }) {
  const [selected, setSelected] = useState<number | null>(null);
  const folds = experiment.plan.folds;
  const fold = folds.find((item) => item.ordinal === selected) ?? folds[0];
  const trial = experiment.trials.find((item) => item.fold === fold?.ordinal && item.role === "OOS");
  const query = useQuery({
    queryKey: ["intraday-validation-daily", experiment.id, trial?.id],
    queryFn: () => api<{ report: IntradayDailyReport | null }>(`/intraday/validations/${encodeURIComponent(experiment.id)}/trials/${encodeURIComponent(trial!.id)}/daily`),
    enabled: !!trial && trial.status === "COMPLETED",
    staleTime: Infinity,
  });
  const report = query.data?.report;
  const summary = report?.summary;
  const optimization = getValidationOptimization(experiment.config);
  const stats = summary ? [
    { label: "평균 일 수익률", value: pct(summary.meanReturnPct), note: `중앙값 ${pct(summary.medianReturnPct)}`, color: pnlClass(summary.meanReturnPct) },
    { label: "수익일 비율", value: proportion(summary.profitableDayPct), note: `수익 ${summary.profitableDays}일 / 정상 평가 ${summary.evaluatedDays}일`, color: "" },
    { label: "최악의 일 수익률", value: pct(summary.worstReturnPct), note: summary.worstDate ?? "—", color: pnlClass(summary.worstReturnPct) },
    { label: "Sharpe · 일별", value: num(summary.sharpe), note: `정상 평가 ${summary.evaluatedDays}일`, color: sharpeClass(summary.sharpe) },
  ] : [];

  return (
    <div className="space-y-4">
      {folds.length > 1 && fold ? (
        <div className="max-w-sm space-y-2">
          <label htmlFor="validation-daily-fold" className="text-sm font-medium">평가할 OOS 구간</label>
          <Select value={String(fold.ordinal)} onValueChange={(value) => setSelected(Number(value))}>
            <SelectTrigger id="validation-daily-fold"><SelectValue /></SelectTrigger>
            <SelectContent>{folds.map((item) => (
              <SelectItem key={item.ordinal} value={String(item.ordinal)}>
                {item.ordinal + 1}회차 · {item.test.from} ~ {item.test.to}
              </SelectItem>
            ))}</SelectContent>
          </Select>
        </div>
      ) : null}
      {fold ? <p className="text-sm text-muted-foreground">선택 구간 OOS {fold.test.from} ~ {fold.test.to} · IS {fold.train.from} ~ {fold.train.to}</p> : null}
      {query.isError ? <Alert variant="destructive"><AlertDescription>일별 성과를 불러오지 못했습니다. {query.error.message}</AlertDescription></Alert> : null}
      {trial?.status === "COMPLETED" && query.isLoading ? <p className="text-sm">일별 성과를 불러오는 중…</p> : null}
      {trial?.status !== "COMPLETED" || (query.isSuccess && !report) ? (
        <p className="text-sm text-muted-foreground">{unavailableMessage(trial, query.isSuccess && !report)}</p>
      ) : null}
      {summary && report ? <>
        <Alert variant={summary.isComplete ? "default" : "destructive"}>
          <AlertDescription className="space-y-2">
            <p>
              정상 평가 {summary.evaluatedDays} / {summary.expectedDays}일 · {quality(summary)}
              {summary.earlyTermination ? ` · ${summary.earlyTermination.date} 청산 실패로 조기 종료 (잔여 ${summary.earlyTermination.remainingQuantity}주)` : ""}
              <InfoHint label="정상 평가일 설명" className="ml-2">정상 평가된 날짜만 일별 통계에 포함합니다. 누락, 부분 시세, 청산 실패 및 미실행일은 0%로 대체하지 않습니다.</InfoHint>
            </p>
            <Progress aria-label="정상 평가일 비율" value={summary.expectedDays ? summary.evaluatedDays / summary.expectedDays * 100 : 0} />
          </AlertDescription>
        </Alert>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="OOS 일별 핵심 지표">
          {stats.map(({ label, value, note, color }) => (
            <Card key={label} size="sm"><CardContent>
              <p className="text-xs text-muted-foreground sm:text-sm">{label}</p>
              <p className={`text-lg font-semibold sm:text-2xl ${color}`}>{value}</p>
              <p className="text-xs text-muted-foreground">{note}</p>
            </CardContent></Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">일별 수익률 <InfoHint label="일별 수익률 설명">전일 마감 자산 대비 당일 마감 자산 변화율입니다. 비용을 포함하며 정상 평가된 무거래일은 0%입니다.</InfoHint></CardTitle>
            <p className="text-sm text-muted-foreground">비용 포함 · 정상 평가된 무거래일은 0% · 평가 불가일은 제외</p>
            <p className="text-xs text-muted-foreground"><span className="text-gain">■</span> 수익 · <span className="text-loss">■</span> 손실 · ● 0% · × 평가 불가</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="h-56 w-full" role="img" aria-label="날짜별 일 수익률 막대 그래프. 빨강은 수익, 파랑은 손실, 점은 0%, X는 평가 불가입니다.">
              <ResponsiveContainer>
                <BarChart data={report.days.map((day) => ({ ...day, chartReturn: day.status === "COMPLETE" ? day.returnPct : null }))}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="date" minTickGap={24} tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
                  <YAxis tickFormatter={(v: number) => `${v}%`} width={48} tick={axisTick} tickLine={false} axisLine={false} />
                  <Tooltip {...chartTooltipProps} formatter={(value) => [pct(Number(value)), "수익률"]} />
                  <Bar dataKey="chartReturn" isAnimationActive={false}>
                    {report.days.map((day) => <Cell key={day.date} fill={(day.returnPct ?? 0) >= 0 ? "var(--gain)" : "var(--loss)"} />)}
                  </Bar>
                  {report.days.filter((day) => day.status !== "COMPLETE" || day.returnPct === 0).map((day) => (
                    <ReferenceDot key={day.date} x={day.date} y={0} ifOverflow="extendDomain" r={day.status === "COMPLETE" ? 3 : 4}
                      fill={day.status === "COMPLETE" ? "var(--muted-foreground)" : "none"} stroke="var(--muted-foreground)"
                      shape={day.status === "COMPLETE" ? undefined : (props: { cx?: number; cy?: number }) => <path d={`M ${(props.cx ?? 0) - 4} ${(props.cy ?? 0) - 4} l 8 8 m -8 0 l 8 -8`} stroke="var(--muted-foreground)" strokeWidth={2} />}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-3">
              <div><p className="text-muted-foreground">일 수익률 표준편차</p><p className="font-medium">{summary.standardDeviationPct === null ? "—" : `${num(summary.standardDeviationPct)}%p`}</p></div>
              <div><p className="text-muted-foreground">최대 연속 손실 <InfoHint label="연속 손실 설명">평가 불가 날짜를 만나면 연속 손실을 끊고 다시 계산합니다.</InfoHint></p><p className="font-medium">{summary.maxConsecutiveLossDays}일</p></div>
              <div><p className="text-muted-foreground">최악의 장중 MDD</p><p className={`font-medium ${pnlClass(summary.worstIntradayDrawdownPct)}`}>{pct(summary.worstIntradayDrawdownPct)}</p></div>
              <div><p className="text-muted-foreground">상위 3일 수익 집중도 <InfoHint label="수익 집중도 설명">수익이 난 정상 평가일의 손익 합계 중 상위 3일이 차지하는 비율입니다.</InfoHint></p><p className="font-medium">{proportion(summary.top3ProfitSharePct)}</p></div>
              <div><p className="text-muted-foreground">실제 거래일 / 정상 평가일</p><p className="font-medium">{summary.activeDays} / {summary.evaluatedDays}일</p></div>
              <div><p className="text-muted-foreground">장 마감 청산 실패</p><p className="font-medium">{summary.exitFailedDays}일</p></div>
            </div>
            {report.days.some((day) => day.status !== "COMPLETE") ? (
              <details><summary className="cursor-pointer text-sm">평가에서 제외된 날짜</summary>
                <Table><TableHeader><TableRow><TableHead>날짜</TableHead><TableHead>상태</TableHead><TableHead className="text-right">관측 손익</TableHead><TableHead className="text-right">누락 분</TableHead></TableRow></TableHeader>
                  <TableBody>{report.days.filter((day) => day.status !== "COMPLETE").map((day) => (
                    <TableRow key={day.date}><TableCell>{day.date}</TableCell><TableCell>{statuses[day.status]}</TableCell><TableCell className={`text-right ${pnlClass(day.pnl)}`}>{day.pnl === null ? "—" : formatKrw(day.pnl)}</TableCell><TableCell className="text-right">{day.missingMinutes}</TableCell></TableRow>
                  ))}</TableBody>
                </Table>
              </details>
            ) : null}
          </CardContent>
        </Card>
      </> : null}
      <div className="space-y-2">
        <h3 className="font-semibold">OOS 구간 비교</h3>
        <p className="text-sm text-muted-foreground">각 구간은 초기 자금으로 독립 실행하며 연속 운용 성과가 아닙니다.</p>
        <Table>
          <TableHeader><TableRow>
            <TableHead>회차 / 기간</TableHead><TableHead className="text-right">OOS 수익률</TableHead><TableHead className="text-right">평균 일 수익률</TableHead><TableHead className="text-right">Sharpe</TableHead><TableHead className="text-right">평가일</TableHead><TableHead>확인 사항</TableHead><TableHead className="text-right">OOS MDD</TableHead><TableHead className="text-right">매도 체결</TableHead><TableHead className="text-right">IS 수익률</TableHead>{optimization ? <TableHead className="text-right">고정 전략 OOS</TableHead> : null}<TableHead>일별 성과</TableHead>
          </TableRow></TableHeader>
          <TableBody>{folds.map((item) => {
            const items = experiment.trials.filter((t) => t.fold === item.ordinal);
            const oos = items.find((t) => t.role === "OOS");
            const train = items.find((t) => t.role === "TRAIN" && t.candidate === (optimization ? oos?.candidate : 0));
            const baseline = items.find((t) => t.role === "BASELINE");
            const s = oos?.status === "COMPLETED" ? oos.metrics?.intradayDaily : undefined;
            const value = oos?.status === "COMPLETED" && (!s || s.isComplete) ? oos.metrics?.totalReturnPct : null;
            const baselineValue = baseline?.status === "COMPLETED" && (!baseline.metrics?.intradayDaily || baseline.metrics.intradayDaily.isComplete) ? baseline.metrics?.totalReturnPct : null;
            return <TableRow key={item.ordinal} aria-selected={fold?.ordinal === item.ordinal} data-state={fold?.ordinal === item.ordinal ? "selected" : undefined}>
              <TableCell className="whitespace-normal">
                <p>{item.ordinal + 1}회차</p>
                <p className="text-xs"><span className="whitespace-nowrap">OOS {item.test.from}</span>{" "}<span className="whitespace-nowrap">~ {item.test.to}</span></p>
                <p className="text-xs text-muted-foreground"><span className="whitespace-nowrap">IS {item.train.from}</span>{" "}<span className="whitespace-nowrap">~ {item.train.to}</span></p>
              </TableCell>
              <TableCell className={`text-right ${pnlClass(value)}`}>{resultLink(oos, oos?.status === "NOT_EVALUATED" ? "미평가 (선택 후보 없음)" : oos?.status === "COMPLETED" ? pct(value) : oos?.status ?? "대기")}</TableCell>
              <TableCell className={`text-right ${pnlClass(s?.meanReturnPct)}`}>{pct(s?.meanReturnPct)}</TableCell>
              <TableCell className={`text-right ${sharpeClass(oos?.metrics?.sharpe)}`}>{num(oos?.status === "COMPLETED" ? oos.metrics?.sharpe : null)}</TableCell>
              <TableCell className="text-right">{s ? `${s.evaluatedDays} / ${s.expectedDays}일` : "—"}</TableCell>
              <TableCell>{s ? quality(s) : "보고서 없음"}</TableCell>
              <TableCell className={`text-right ${pnlClass(oos?.metrics?.maxDrawdownPct)}`}>{pct(oos?.status === "COMPLETED" ? oos.metrics?.maxDrawdownPct : null)}</TableCell>
              <TableCell className="text-right">{oos?.status === "COMPLETED" ? oos.metrics?.tradeCount ?? "—" : "—"}</TableCell>
              <TableCell className={`text-right ${pnlClass(train?.metrics?.totalReturnPct)}`}>{resultLink(train, pct(train?.metrics?.totalReturnPct))}</TableCell>
              {optimization ? <TableCell className={`text-right ${pnlClass(baselineValue)}`}>{resultLink(baseline, baseline?.metrics?.intradayDaily && !baseline.metrics.intradayDaily.isComplete ? "불완전" : pct(baselineValue))}</TableCell> : null}
              <TableCell><Button variant="outline" size="sm" aria-pressed={fold?.ordinal === item.ordinal} onClick={() => setSelected(item.ordinal)}>{fold?.ordinal === item.ordinal ? "선택됨" : "보기"}</Button></TableCell>
            </TableRow>;
          })}</TableBody>
        </Table>
      </div>
      <details className="text-sm"><summary className="cursor-pointer">계산 기준 및 검증 해석</summary><p>정상 평가된 무거래일을 포함하고 누락 및 미실행일은 0%로 대체하지 않습니다. 조기 종료 구간은 완전한 OOS 성과가 아닙니다.</p></details>
    </div>
  );
}
