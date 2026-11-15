import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { api } from "@/lib/api-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { PeriodValidationDto } from "../../../shared/schemas/period-validation.js";
import { useBacktestLive, useStrategies } from "./api";
import { BacktestBreadcrumbs } from "./backtest-breadcrumbs";
import { extractNumberParams } from "./param-specs";
import { active, MODE_LABELS, PeriodValidationSection, ValidationResult } from "./period-validation-section";

export function PeriodValidationPage() {
  const { id = "" } = useParams();
  const source = useBacktestLive(id);
  const strategies = useStrategies();
  if (source.isError) return <Alert variant="destructive"><AlertDescription>{source.error.message}</AlertDescription></Alert>;
  if (!source.job) return <Skeleton className="h-64 w-full" />;
  return <div className="space-y-4"><BacktestBreadcrumbs jobId={id} trail={[{ label: "기간 검증" }]} /><div><h2 className="text-lg font-semibold">기간 검증</h2><p className="text-sm text-muted-foreground">{strategies.data?.strategies.find((strategy) => strategy.id === source.job?.strategyId)?.name ?? source.job.strategyId} · {source.job.request.period.from} ~ {source.job.request.period.to}</p></div><PeriodValidationSection jobId={id} request={source.job.request} /></div>;
}

export function PeriodValidationDetailPage() {
  const { validationId = "" } = useParams();
  const query = useQuery({
    queryKey: ["period-validation", validationId],
    queryFn: () => api<{ experiment: PeriodValidationDto }>(`/backtest-validations/${validationId}`),
    refetchInterval: (q) => q.state.data && active(q.state.data.experiment) ? 2_000 : false,
  });
  const experiment = query.data?.experiment;
  if (query.isError) return <Alert variant="destructive"><AlertDescription>{query.error.message}</AlertDescription></Alert>;
  if (!experiment) return <Skeleton className="h-64 w-full" />;
  return <PeriodValidationDetail experiment={experiment} validationId={validationId} />;
}

function PeriodValidationDetail({ experiment, validationId }: { experiment: PeriodValidationDto; validationId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const source = useBacktestLive(experiment.sourceJobId);
  const strategyId = source.job?.request.strategyId;
  const schema = useQuery({
    queryKey: ["strategy-schema", strategyId],
    queryFn: () => api<{ schema: Record<string, unknown> }>(`/strategies/${strategyId}/schema`),
    enabled: Boolean(strategyId), staleTime: 60_000,
  });
  const specs = useMemo(() => extractNumberParams(schema.data?.schema), [schema.data]);
  if (source.isLoading || (Boolean(strategyId) && schema.isLoading)) return <Skeleton className="h-64 w-full" />;
  const refresh = async (deleted = false) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["period-validation", validationId], refetchType: deleted ? "none" : "active" }),
      queryClient.invalidateQueries({ queryKey: ["period-validations", experiment.sourceJobId] }),
      queryClient.invalidateQueries({ queryKey: ["backtests"] }),
      queryClient.invalidateQueries({ queryKey: ["backtest-experiments"] }),
    ]);
  };
  return <div className="space-y-4"><BacktestBreadcrumbs jobId={experiment.sourceJobId} trail={[{ label: "기간 검증", href: `/backtests/${experiment.sourceJobId}/validations` }, { label: MODE_LABELS[experiment.config.mode] }]} />{source.isError ? <Alert variant="destructive"><AlertDescription>원본 백테스트를 불러오지 못했습니다. 매개변수 이름은 원래 키로 표시합니다. {source.error.message}</AlertDescription></Alert> : null}<ValidationResult experiment={experiment} specs={specs} refresh={refresh} onDeleted={() => void navigate(`/backtests/${experiment.sourceJobId}/validations`)} /></div>;
}
