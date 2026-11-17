import { summarizeValidationOos } from "./period-validation-summary";
import { isRefreshRequired, useBacktestRefresh } from "./backtest-refresh-dialog";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { InfoHint } from "@/components/info-hint";
import { VALIDATION_MODE_HELP } from "./experiment-help";
import { api } from "@/lib/api-client";
import {
  formatDateTime,
  formatKrw,
  formatNumber,
  formatSignedPct,
  pnlClass,
  sharpeClass,
} from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { backtestRequestSchema } from "../../../shared/schemas/backtest-request.js";
import { intradayRequestSchema, type IntradayRequest } from "@shared/schemas/intraday";
import {
  buildPeriodValidationPlan,
  getValidationOptimization,
  PERIOD_VALIDATION_MODE_LABELS,
  periodValidationLabel,
  type ValidationOptimization,
  periodValidationConfigSchema,
  type PeriodValidationConfig,
  type PeriodValidationDto,
  type ValidationTrialDto,
} from "../../../shared/schemas/period-validation.js";
import {
  paramLabel,
  type NumberParamSpec,
} from "./param-specs";
import type { BacktestRequestBody } from "./types";
import { experimentPaths, type ExperimentMode } from "./experiment-paths";
import { useExperimentParameters } from "./use-experiment-parameters";

export const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "진행 중",
  COMPLETED: "",
  FAILED: "실패",
  CANCELLING: "취소 중",
  CANCELLED: "취소",
  PENDING: "대기",
  QUEUED: "실행 대기",
  STARTING: "시작 중",
  RUNNING: "실행 중",
  PREPARING: "데이터 준비 중",
  INTERRUPTED: "중단",
  SKIPPED: "미실행",
  NOT_EVALUATED: "미평가",
  MISSING: "결과 없음",
  PREPARATION_QUEUED: "데이터 준비 대기",
  PREPARATION_RUNNING: "데이터 준비 중",
  PREPARATION_WAITING_DAILY_QUOTA: "API 할당량 대기",
  PREPARATION_FAILED: "데이터 준비 실패",
  PREPARATION_CANCELLED: "데이터 준비 취소",
};
export const active = (experiment: PeriodValidationDto): boolean =>
  ["ACTIVE", "CANCELLING"].includes(experiment.status);

function parameterText(
  trial: ValidationTrialDto | undefined,
  config: PeriodValidationConfig,
  specs: NumberParamSpec[],
): string {
  const optimization = getValidationOptimization(config);
  if (trial?.status === "NOT_EVALUATED") return "선택 후보 없음";
  if (!trial?.parameters) return optimization ? "선택 대기" : "원본 설정";
  if (!optimization || trial.role === "BASELINE") return "원본 설정";
  return optimization.axes
    .map(({ key }) => {
      const spec = specs.find((item) => item.key === key);
      return `${spec ? paramLabel(spec) : key} ${String(trial.parameters![key])}`;
    })
    .join(" · ");
}

function CandidateSelection({
  trial,
  optimization,
}: {
  trial: ValidationTrialDto;
  optimization: ValidationOptimization;
}) {
  const selection = trial.selection;
  if (!selection) return null;
  const objective = optimization.objective === "sharpe" ? "Sharpe" : "CAGR";
  const score = trial.metrics?.[optimization.objective];
  const trades = trial.metrics?.tradeCount;
  const drawdown = trial.metrics?.maxDrawdownPct;
  const finite = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value);
  const absoluteDrawdown = finite(drawdown) ? Math.abs(drawdown!) : null;
  const drawdownText = absoluteDrawdown === null ? "—" : absoluteDrawdown > optimization.maxDrawdownPct && Number(absoluteDrawdown.toFixed(2)) <= optimization.maxDrawdownPct
    ? `${absoluteDrawdown}%` : `${formatNumber(absoluteDrawdown)}%`;
  const reasons: Record<string, string> = {
    OBJECTIVE_UNAVAILABLE: `${objective} 값 없음`,
    TRADE_COUNT_UNAVAILABLE: "매도 체결 수 없음",
    INSUFFICIENT_TRADES: "매도 체결 수 미달",
    DRAWDOWN_UNAVAILABLE: "MDD 값 없음",
    DRAWDOWN_LIMIT_EXCEEDED: "MDD 한도 초과",
  };
  return <div className="space-y-1 text-xs">
    <p className="font-medium">{selection.eligible ? "조건 충족" : "조건 탈락"}</p>
    <p>{objective}: {finite(score) ? `${formatNumber(score)}${optimization.objective === "cagrPct" ? "%" : ""}` : "—"} (유효한 값, 최대 선택)</p>
    <p>매도 체결: {finite(trades) ? `${trades}건` : "—"} / {optimization.minTrades}건 이상</p>
    <p>MDD 크기: {drawdownText} / {optimization.maxDrawdownPct}% 이하</p>
    {selection.reasons.map((reason) => <p className="text-destructive" key={reason}>{reasons[reason] ?? reason}</p>)}
  </div>;
}

function TrialLink({
  trial,
  children,
  mode = "daily",
}: {
  trial: ValidationTrialDto | undefined;
  children: React.ReactNode;
  mode?: ExperimentMode;
}) {
  return trial?.jobId ? (
    <Link
      className="underline underline-offset-4"
      to={experimentPaths(mode).result(trial.jobId)}
    >
      {children}
    </Link>
  ) : (
    <>{children}</>
  );
}

export function ValidationResult({
  experiment,
  specs,
  refresh,
  onDeleted,
  mode = "daily",
}: {
  experiment: PeriodValidationDto;
  specs: NumberParamSpec[];
  refresh: (deleted?: boolean) => Promise<void>;
  onDeleted?: () => void;
  mode?: ExperimentMode;
}) {
  const paths = experimentPaths(mode);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: (action: "cancel" | "delete") =>
      api(
        `${paths.apiValidation(experiment.id)}${action === "cancel" ? "/cancel" : ""}`,
        {
          method: action === "cancel" ? "POST" : "DELETE",
        },
      ),
    onSuccess: async (_data, action) => {
      setDeleteOpen(false);
      await refresh(action === "delete");
      if (action === "delete") onDeleted?.();
    },
  });
  const completed = experiment.trials.filter(
    (trial) => trial.status === "COMPLETED",
  ).length;
  const summary = summarizeValidationOos(experiment.trials);
  const optimization = getValidationOptimization(experiment.config);
  const notEvaluated = experiment.trials.filter((trial) => trial.status === "NOT_EVALUATED").length;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            {periodValidationLabel(experiment.config)}{experiment.status !== "COMPLETED" ? ` · ${STATUS_LABELS[experiment.status]}` : ""}
            <InfoHint label={`${PERIOD_VALIDATION_MODE_LABELS[experiment.config.mode]} 설명`} className="ml-2">{VALIDATION_MODE_HELP[experiment.config.mode]}</InfoHint>
          </CardTitle>
          {active(experiment) ? (
            <Button
              size="sm"
              variant="outline"
              disabled={
                mutation.isPending || experiment.status === "CANCELLING"
              }
              onClick={() => mutation.mutate("cancel")}
            >
              실험 취소
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDeleteOpen(true)}
            >
              실험 삭제
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {formatDateTime(experiment.createdAtMs)} · 실행 {completed}/
          {experiment.plan.totalRuns}회 완료 · 미평가 {notEvaluated}회 · 각 구간 초기자금{" "}
          {formatKrw(experiment.initialCash)}
        </p>
        {optimization ? (
          <p className="text-sm text-muted-foreground">
            IS 선택 기준:{" "}
            {optimization.objective === "sharpe"
              ? "Sharpe"
              : "CAGR"}{" "}
            최대 · 매도 체결 {optimization.minTrades}건 이상 ·
            MDD 크기 {optimization.maxDrawdownPct}% 이하
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {experiment.error || mutation.error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {experiment.error ?? mutation.error?.message}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-1 text-sm">
          <p>{optimization ? "선택 전략" : "원본 설정"} OOS 평가 {summary.evaluated}/{experiment.plan.folds.length}회{optimization ? ` · 후보가 없어 미평가 ${summary.notEvaluated}회` : ""}</p>
          <p>평균 수익률 {summary.mean === null ? "—" : formatSignedPct(summary.mean)} · 수익률 표준편차 {summary.standardDeviation === null ? "—" : `${formatNumber(summary.standardDeviation)}%p`} <InfoHint label="수익률 표준편차 설명">평가된 회차의 수익률로 모집단 표준편차를 계산합니다. 평가된 회차가 두 개 미만이면 —로 표시합니다.</InfoHint> · 수익 회차 {summary.profitable}/{summary.evaluated}회 · 최악 회차 {summary.worst === null ? "—" : formatSignedPct(summary.worst)}</p>
          {experiment.status === "COMPLETED" && summary.evaluated === 0 ? <p>평가된 OOS가 없습니다.</p> : null}
          <p className="text-muted-foreground">평가된 회차 기준이며, 전체 기간의 연속 운용 성과가 아닙니다.</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>회차 / 기간</TableHead>
              <TableHead>{optimization ? "선택 매개변수" : "매개변수"}</TableHead>
              <TableHead>IS 수익률</TableHead>
              <TableHead>OOS 수익률</TableHead>
              <TableHead>OOS CAGR</TableHead>
              <TableHead>OOS MDD</TableHead>
              <TableHead>OOS Sharpe</TableHead>
              <TableHead>OOS 매도 체결</TableHead>
              {optimization ? (
                <TableHead>고정 전략 OOS</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {experiment.plan.folds.map((fold) => {
              const trials = experiment.trials.filter(
                (trial) => trial.fold === fold.ordinal,
              );
              const test = trials.find((trial) => trial.role === "OOS");
              const train = trials.find(
                (trial) =>
                  trial.role === "TRAIN" &&
                  trial.candidate ===
                    (!optimization
                      ? 0
                      : test?.candidate),
              );
              const testMetrics = test?.status === "COMPLETED" ? test.metrics : null;
              const baseline = trials.find(
                (trial) => trial.role === "BASELINE",
              );
              return (
                <TableRow key={fold.ordinal}>
                  <TableCell className="whitespace-nowrap">
                    {fold.ordinal + 1}회차
                    <br />
                    IS {fold.train.from} ~ {fold.train.to}
                    <br />
                    OOS {fold.test.from} ~ {fold.test.to}
                  </TableCell>
                  <TableCell>
                    {parameterText(
                      !optimization ? train : test,
                      experiment.config,
                      specs,
                    )}
                  </TableCell>
                  <TableCell className={pnlClass(train?.metrics?.totalReturnPct)}>
                    <TrialLink trial={train} mode={mode}>
                      {formatSignedPct(train?.metrics?.totalReturnPct ?? null)}
                    </TrialLink>
                  </TableCell>
                  <TableCell className={pnlClass(testMetrics?.totalReturnPct)}>
                    <TrialLink trial={test} mode={mode}>
                      {testMetrics
                        ? formatSignedPct(testMetrics.totalReturnPct)
                        : test?.skipReason === "NO_ELIGIBLE_CANDIDATE"
                          ? "미평가 (선택 후보 없음)"
                          : STATUS_LABELS[test?.status ?? "PENDING"] || "—"}
                    </TrialLink>
                  </TableCell>
                  <TableCell className={pnlClass(testMetrics?.cagrPct)}>
                    {formatSignedPct(testMetrics?.cagrPct ?? null)}
                  </TableCell>
                  <TableCell className={pnlClass(testMetrics?.maxDrawdownPct)}>
                    {formatSignedPct(testMetrics?.maxDrawdownPct ?? null)}
                  </TableCell>
                  <TableCell className={sharpeClass(testMetrics?.sharpe)}>
                    {formatNumber(testMetrics?.sharpe ?? null)}
                  </TableCell>
                  <TableCell>{testMetrics?.tradeCount ?? "-"}</TableCell>
                  {optimization ? (
                    <TableCell>
                      <TrialLink trial={baseline} mode={mode}>
                        {formatSignedPct(
                          baseline?.metrics?.totalReturnPct ?? null,
                        )}
                      </TrialLink>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <details>
          <summary className="cursor-pointer text-sm">
            {optimization ? "후보별 실행과 상세 결과" : "실행 상세 결과"}
          </summary>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>회차 / 용도</TableHead>
                <TableHead>매개변수</TableHead>
                <TableHead>상태 / 결과</TableHead>
                {optimization ? <TableHead>후보 선택 조건</TableHead> : null}
                <TableHead>수익률</TableHead>
                <TableHead>CAGR</TableHead>
                <TableHead>MDD</TableHead>
                <TableHead>Sharpe</TableHead>
                <TableHead>매도 체결</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {experiment.trials.map((trial) => (
                <TableRow key={trial.id}>
                  <TableCell>
                    {trial.fold + 1} /{" "}
                    {trial.role === "TRAIN"
                      ? optimization ? "IS 후보" : "원본 설정 IS"
                      : trial.role === "BASELINE"
                        ? "고정 전략 OOS"
                        : optimization ? "선택 전략 OOS" : "원본 설정 OOS"}
                  </TableCell>
                  <TableCell>
                    {parameterText(trial, experiment.config, specs)}
                  </TableCell>
                  <TableCell>
                    <TrialLink trial={trial} mode={mode}>
                      {trial.status === "COMPLETED" ? "결과 보기" : STATUS_LABELS[trial.status] ?? trial.status}
                      {trial.progress !== null && trial.status === "RUNNING"
                        ? ` ${Math.floor(trial.progress)}%`
                        : ""}
                    </TrialLink>
                    {trial.error ? (
                      <p className="text-destructive">{trial.error}</p>
                    ) : null}
                  </TableCell>
                  {optimization ? <TableCell>
                    {trial.role === "TRAIN" && trial.selection ? (
                      <CandidateSelection trial={trial} optimization={optimization} />
                    ) : "—"}
                  </TableCell> : null}
                  <TableCell>
                    {formatSignedPct(trial.status === "NOT_EVALUATED" ? null : trial.metrics?.totalReturnPct ?? null)}
                  </TableCell>
                  <TableCell>
                    {formatSignedPct((trial.status === "NOT_EVALUATED" ? null : trial.metrics?.cagrPct) ?? null)}
                  </TableCell>
                  <TableCell>
                    {formatSignedPct((trial.status === "NOT_EVALUATED" ? null : trial.metrics?.maxDrawdownPct) ?? null)}
                  </TableCell>
                  <TableCell className={sharpeClass(trial.status === "NOT_EVALUATED" ? null : trial.metrics?.sharpe)}>
                    {formatNumber((trial.status === "NOT_EVALUATED" ? null : trial.metrics?.sharpe) ?? null)}
                  </TableCell>
                  <TableCell>{trial.status === "NOT_EVALUATED" ? "—" : trial.metrics?.tradeCount ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>검증 실험 삭제</DialogTitle>
              <DialogDescription>
                이 실험의 설정과 모든 하위 백테스트 결과를 삭제합니다.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)}>
                닫기
              </Button>
              <Button
                variant="destructive"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate("delete")}
              >
                삭제
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export function PeriodValidationSection({
  jobId,
  request,
  mode: backtestMode = "daily",
}: {
  jobId: string;
  request: BacktestRequestBody | IntradayRequest;
  mode?: ExperimentMode;
}) {
  const queryClient = useQueryClient();
  const refreshFlow = useBacktestRefresh(jobId);
  const paths = experimentPaths(backtestMode);
  const intraday = backtestMode === "intraday";
  const queryKey = [paths.validationsKey, jobId];
  const experiments = useQuery({
    queryKey,
    queryFn: () =>
      api<{ experiments: PeriodValidationDto[] }>(
        paths.apiValidations(jobId),
      ),
    refetchInterval: (query) =>
      query.state.data?.experiments.some(active) ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const schema = useExperimentParameters(request.strategyId, backtestMode);
  const specs = schema.specs;
  const [mode, setMode] = useState<PeriodValidationConfig["mode"]>("HOLDOUT");
  const [splitDate, setSplitDate] = useState(() => {
    const start = Date.parse(`${request.period.from}T00:00:00Z`);
    const end = Date.parse(`${request.period.to}T00:00:00Z`);
    return new Date(
      start + Math.floor(((end - start) / 86_400_000) * 0.7) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
  });
  const [trainMonths, setTrainMonths] = useState(intraday ? "3" : "36");
  const [testMonths, setTestMonths] = useState(intraday ? "1" : "6");
  const [optimizationEnabled, setOptimizationEnabled] = useState(false);
  const [axes, setAxes] = useState([{ key: "", values: "" }]);
  const [objective, setObjective] = useState("sharpe");
  const [minTrades, setMinTrades] = useState("5");
  const [maxDrawdown, setMaxDrawdown] = useState("30");
  const preview = useMemo(() => {
    try {
      const optimization = {
        axes: (optimizationEnabled ? axes : []).map((axis) => {
          const values = axis.values.split(",").map((value) => value.trim());
          if (values.some((value) => value === ""))
            throw new Error("후보값을 쉼표로 구분해 2개 이상 입력하세요.");
          return { key: axis.key, values: values.map(Number) };
        }),
        objective,
        minTrades: Number(minTrades),
        maxDrawdownPct: Number(maxDrawdown),
      };
      const input =
        mode === "HOLDOUT"
          ? { mode, splitDate, ...(optimizationEnabled ? { optimization } : {}) }
          : {
              mode,
              trainMonths: Number(trainMonths),
              testMonths: Number(testMonths),
              ...(optimizationEnabled ? { optimization } : {}),
            };
      const parsed = periodValidationConfigSchema.safeParse(input);
      if (!parsed.success)
        throw new Error(
          optimizationEnabled
            ? "기간과 최적화 설정을 확인하세요. 매개변수 후보는 2개 이상 필요합니다."
            : "기간 설정을 확인하세요.",
        );
      return {
        config: parsed.data,
        plan: buildPeriodValidationPlan(
          intraday ? intradayRequestSchema.parse(request) : backtestRequestSchema.parse(request),
          parsed.data,
        ),
        error: null,
      };
    } catch (error) {
      return {
        config: null,
        plan: null,
        error: error instanceof Error ? error.message : "설정을 확인하세요.",
      };
    }
  }, [
    request,
    intraday,
    mode,
    optimizationEnabled,
    splitDate,
    trainMonths,
    testMonths,
    axes,
    objective,
    minTrades,
    maxDrawdown,
  ]);
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.invalidateQueries({ queryKey: [intraday ? "intraday-runs" : "backtests"] });
    await queryClient.invalidateQueries({ queryKey: [paths.summaryKey] });
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };
  const create = useMutation({
    mutationFn: (config: PeriodValidationConfig) =>
      api(paths.apiValidations(jobId), {
        method: "POST",
        body: JSON.stringify(config),
      }),
    onSuccess: refresh,
    onError: (error, config) => {
      if (!intraday && isRefreshRequired(error)) refreshFlow.offer({ kind: "PERIOD_VALIDATION", config }, error);
    },
  });
  return (
    <section
      id="period-validation"
      className="space-y-4 min-w-0"
      aria-label="기간 검증"
    >
      {!intraday ? refreshFlow.modal : null}
      <Card>
        <CardHeader>
          <CardTitle>새 기간검증</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            각 IS/OOS를 초기자금 {formatKrw("initialCash" in request ? request.initialCash : request.capital.initialCash)}과
            무포지션 상태에서 다시 실행합니다. {intraday ? "분봉 지표는 매일 초기화하며 해당 날짜의 확정 봉만 사용합니다." : "지표 준비에는 시작일 이전 데이터를 사용합니다."} 구간 말 미청산 보유분은 평가금액으로 반영합니다.
            구간 수익률을 연속 운용 수익률로 합산하지 않습니다.
          </p>
          {intraday ? <p className="text-sm text-muted-foreground">실험을 생성할 때 보관된 시세와 현재 실행 버전을 기준으로 계산합니다. 실험 도중 데이터나 실행 버전이 바뀌면 중단합니다. 난수는 사용하지 않습니다.</p> : null}
          <p className="text-sm text-muted-foreground">
            이미 확인한 기간을 나누는 실험입니다. OOS 결과를 보고 설정을
            수정하면 미사용 데이터에 대한 검증으로 해석할 수 없습니다.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <Label htmlFor="validation-mode">검증 방식</Label>
                <InfoHint label={`${PERIOD_VALIDATION_MODE_LABELS[mode]} 설명`}>{VALIDATION_MODE_HELP[mode]}</InfoHint>
              </div>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as typeof mode)}
              >
                <SelectTrigger id="validation-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PERIOD_VALIDATION_MODE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mode === "WALK_FORWARD" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="validation-train">학습 기간 (개월)</Label>
                  <Input
                    id="validation-train"
                    type="number"
                    min={1}
                    max={120}
                    value={trainMonths}
                    onChange={(event) => setTrainMonths(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="validation-test">평가·이동 기간 (개월)</Label>
                  <Input
                    id="validation-test"
                    type="number"
                    min={1}
                    max={60}
                    value={testMonths}
                    onChange={(event) => setTestMonths(event.target.value)}
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="validation-split">OOS 시작일</Label>
                <Input
                  id="validation-split"
                  type="date"
                  min={request.period.from}
                  max={request.period.to}
                  value={splitDate}
                  onChange={(event) => setSplitDate(event.target.value)}
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input id="validation-optimize" type="checkbox" checked={optimizationEnabled} onChange={(event) => setOptimizationEnabled(event.target.checked)} />
            <Label htmlFor="validation-optimize">파라미터 최적화</Label>
          </div>
          {!optimizationEnabled ? (
            <p className="text-sm text-muted-foreground">각 회차에서 원본 설정으로 IS와 OOS를 독립적으로 실행합니다. IS 성과와 관계없이 원본 설정을 OOS에 사용합니다.</p>
          ) : null}
          {optimizationEnabled ? (
            <>
              {axes.map((axis, index) => (
                <div
                  className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]"
                  key={index}
                >
                  <div className="space-y-2">
                    <Label htmlFor={`validation-param-${index}`}>
                      탐색 매개변수 {index + 1}
                    </Label>
                    <Select
                      value={axis.key}
                      onValueChange={(key) =>
                        setAxes((items) =>
                          items.map((item, i) =>
                            i === index ? { ...item, key } : item,
                          ),
                        )
                      }
                    >
                      <SelectTrigger id={`validation-param-${index}`}>
                        <SelectValue placeholder="매개변수 선택" />
                      </SelectTrigger>
                      <SelectContent>
                        {specs.map((spec) => (
                          <SelectItem key={spec.key} value={spec.key}>
                            {paramLabel(spec)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`validation-values-${index}`}>
                      후보값 (쉼표 구분)
                    </Label>
                    <Input
                      id={`validation-values-${index}`}
                      placeholder="예: 10, 20, 40"
                      value={axis.values}
                      onChange={(event) =>
                        setAxes((items) =>
                          items.map((item, i) =>
                            i === index
                              ? { ...item, values: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </div>
                  {index > 0 ? (
                    <Button
                      className="self-end"
                      variant="outline"
                      onClick={() =>
                        setAxes((items) => items.filter((_, i) => i !== index))
                      }
                    >
                      제거
                    </Button>
                  ) : null}
                </div>
              ))}
              {axes.length < 2 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setAxes((items) => [...items, { key: "", values: "" }])
                  }
                >
                  매개변수 추가
                </Button>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="validation-objective">IS 선택 기준</Label>
                  <Select value={objective} onValueChange={setObjective}>
                    <SelectTrigger id="validation-objective">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sharpe">Sharpe 최대</SelectItem>
                      {!intraday ? <SelectItem value="cagrPct">CAGR 최대</SelectItem> : null}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="validation-trades">
                    최소 매도 체결 수 (부분청산 포함)
                  </Label>
                  <Input
                    id="validation-trades"
                    type="number"
                    min={1}
                    value={minTrades}
                    onChange={(event) => setMinTrades(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="validation-drawdown">허용 MDD 크기 (%)</Label>
                  <Input
                    id="validation-drawdown"
                    type="number"
                    min={0.01}
                    max={100}
                    value={maxDrawdown}
                    onChange={(event) => setMaxDrawdown(event.target.value)}
                  />
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                후보 선택은 IS 성과만 사용합니다. {intraday ? "같은 회차의 후보는 동일한 보관 시세로 비교하며, " : "같은 회차의 후보는 동일 난수 시드로 비교하며, "}조건을 만족하는 후보가 없으면 해당 회차의 선택 전략 OOS는 미평가로 남기고 다음 회차를 독립적으로 실행합니다. 고정 전략 OOS는 계속 실행합니다.
              </p>
            </>
          ) : null}
          {preview.plan ? (
            <>
              <p className="font-medium">
                {preview.plan.folds.length}개 구간 · 후보{" "}
                {preview.plan.candidates.length}개 · 백테스트 총{" "}
                {preview.plan.totalRuns}회
                {optimizationEnabled ? " (고정 전략 OOS 비교 포함)" : ""}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>회차</TableHead>
                    <TableHead>IS</TableHead>
                    <TableHead>OOS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.plan.folds.map((fold) => (
                    <TableRow key={fold.ordinal}>
                      <TableCell>{fold.ordinal + 1}</TableCell>
                      <TableCell>
                        {fold.train.from} ~ {fold.train.to}
                      </TableCell>
                      <TableCell>
                        {fold.test.from} ~ {fold.test.to}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {preview.plan.unusedPeriod ? (
                <p className="text-sm text-muted-foreground">
                  평가 기간보다 짧아 제외한 마지막 구간:{" "}
                  {preview.plan.unusedPeriod.from} ~{" "}
                  {preview.plan.unusedPeriod.to}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{preview.error}</p>
          )}
          {(create.error && !isRefreshRequired(create.error)) || experiments.error || schema.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {(!isRefreshRequired(create.error) ? create.error?.message : undefined) ??
                  experiments.error?.message ??
                  schema.error?.message}
              </AlertDescription>
            </Alert>
          ) : null}
          <Button
            disabled={
              !preview.config ||
              create.isPending ||
              (experiments.data?.experiments.filter(active).length ?? 0) >= 5
            }
            onClick={() => {
              if (preview.config) create.mutate(preview.config);
            }}
          >
            {create.isPending ? "실험 생성 중…" : "검증 실험 실행"}
          </Button>
        </CardContent>
      </Card>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">검증 실험 기록</h2>
        {experiments.data?.experiments.length === 0 ? <p className="text-sm text-muted-foreground">아직 검증 실험이 없습니다.</p> : null}
        {experiments.data?.experiments.slice().reverse().map((experiment) => (
          <Card key={experiment.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-6">
              <div>
                <Link className="font-medium underline underline-offset-4" to={paths.validation(experiment.id)}>{periodValidationLabel(experiment.config)}</Link>{" "}
                <InfoHint label={`${PERIOD_VALIDATION_MODE_LABELS[experiment.config.mode]} 설명`}>{VALIDATION_MODE_HELP[experiment.config.mode]}</InfoHint>
                <p className="text-sm text-muted-foreground">{formatDateTime(experiment.createdAtMs)}{experiment.status !== "COMPLETED" ? ` · ${STATUS_LABELS[experiment.status] ?? experiment.status}` : ""} · 실행 {experiment.trials.filter((trial) => trial.status === "COMPLETED").length}/{experiment.plan.totalRuns}회 완료 · 미평가 {experiment.trials.filter((trial) => trial.status === "NOT_EVALUATED").length}회</p>
              </div>
              <Button asChild variant="outline" size="sm"><Link to={paths.validation(experiment.id)}>상세 보기</Link></Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
