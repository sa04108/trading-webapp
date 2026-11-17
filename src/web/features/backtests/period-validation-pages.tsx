import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { api, isUnavailableApiError } from "@/lib/api-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { periodValidationLabel, type PeriodValidationDto } from "@shared/schemas/period-validation";
import { BacktestBreadcrumbs } from "./backtest-breadcrumbs";
import { experimentPaths, type ExperimentMode } from "./experiment-paths";
import { useExperimentSource } from "./use-experiment-source";
import { useExperimentParameters } from "./use-experiment-parameters";
import { active, PeriodValidationSection, ValidationResult } from "./period-validation-section";

export function PeriodValidationPage({ mode = "daily" }: { mode?: ExperimentMode }) {
  const { id = "" } = useParams();
  const client = useQueryClient();
  const query = useExperimentSource(id, mode);
  const source = query.source;
  if (query.isError && (!source || isUnavailableApiError(query.error))) return <Alert variant="destructive"><AlertDescription>{query.error?.message}</AlertDescription></Alert>;
  if (!source) return <Skeleton className="h-64 w-full" />;
  return <div className="space-y-4 min-w-0">
    {query.isError ? <Alert variant="destructive"><AlertDescription>원본을 새로 불러오지 못했습니다. <Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: [mode === "intraday" ? "intraday-run" : "backtests", id] })}>다시 시도</Button></AlertDescription></Alert> : null}
    <BacktestBreadcrumbs jobId={id} mode={mode} trail={[{ label: "기간 검증" }]} />
    <div><h2 className="text-lg font-semibold">기간 검증</h2><p className="text-sm text-muted-foreground">{source.name} · {source.request.period.from} ~ {source.request.period.to}</p></div>
    <PeriodValidationSection key={`${mode}:${id}`} jobId={id} request={source.request} mode={mode} />
    <Button asChild variant="outline"><Link to={experimentPaths(mode).result(id)}>원본 결과</Link></Button>
  </div>;
}

export function PeriodValidationDetailPage({ mode = "daily" }: { mode?: ExperimentMode }) {
  const { validationId = "" } = useParams();
  const paths = experimentPaths(mode);
  const query = useQuery({
    queryKey: [paths.validationKey, validationId],
    queryFn: () => api<{ experiment: PeriodValidationDto }>(paths.apiValidation(validationId)),
    refetchInterval: (q) => q.state.data && active(q.state.data.experiment) ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const experiment = query.data?.experiment;
  if (query.isError && (!experiment || isUnavailableApiError(query.error))) return <Alert variant="destructive"><AlertDescription>{query.error.message}</AlertDescription></Alert>;
  if (!experiment) return <Skeleton className="h-64 w-full" />;
  return <><div>{query.isError ? <Alert variant="destructive"><AlertDescription>검증 결과를 새로 불러오지 못했습니다. <Button variant="outline" onClick={() => void query.refetch()}>다시 시도</Button></AlertDescription></Alert> : null}</div><PeriodValidationDetail experiment={experiment} mode={mode} /></>;
}

function PeriodValidationDetail({ experiment, mode }: { experiment: PeriodValidationDto; mode: ExperimentMode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const paths = experimentPaths(mode);
  const source = useExperimentSource(experiment.sourceJobId, mode);
  const parameters = useExperimentParameters(source.source?.request.strategyId, mode);
  if (source.isLoading || parameters.isLoading) return <Skeleton className="h-64 w-full" />;
  if (source.isError && isUnavailableApiError(source.error)) return <Alert variant="destructive"><AlertDescription>{source.error?.message}</AlertDescription></Alert>;
  const refresh = async (deleted = false) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [paths.validationKey, experiment.id], refetchType: deleted ? "none" : "active" }),
      queryClient.invalidateQueries({ queryKey: [paths.validationsKey, experiment.sourceJobId] }),
      queryClient.invalidateQueries({ queryKey: [mode === "intraday" ? "intraday-runs" : "backtests"] }),
      queryClient.invalidateQueries({ queryKey: [paths.summaryKey] }),
      queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    ]);
  };
  return <div className="space-y-4 min-w-0">
    <BacktestBreadcrumbs jobId={experiment.sourceJobId} mode={mode} trail={[{ label: "기간 검증", href: paths.validations(experiment.sourceJobId) }, { label: periodValidationLabel(experiment.config) }]} />
    {source.isError ? <Alert variant="destructive"><AlertDescription>원본 백테스트를 불러오지 못했습니다. 매개변수 이름은 원래 키로 표시합니다. {source.error?.message}</AlertDescription></Alert> : null}
    <ValidationResult experiment={experiment} specs={parameters.specs} refresh={refresh} mode={mode} onDeleted={() => void navigate(paths.validations(experiment.sourceJobId))} />
  </div>;
}
