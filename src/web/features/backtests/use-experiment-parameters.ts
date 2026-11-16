import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { INTRADAY_STRATEGIES } from "@shared/schemas/intraday-strategies";
import { extractNumberParams, type NumberParamSpec } from "./param-specs";
import type { ExperimentMode } from "./experiment-paths";

export function useExperimentParameters(strategyId: string | undefined, mode: ExperimentMode) {
  const schema = useQuery({
    queryKey: ["strategy-schema", strategyId],
    queryFn: () => api<{ schema: Record<string, unknown> }>(`/strategies/${strategyId}/schema`),
    enabled: Boolean(strategyId) && mode === "daily", staleTime: 60_000,
  });
  const specs = useMemo((): NumberParamSpec[] => {
    if (mode === "daily") return extractNumberParams(schema.data?.schema);
    const strategy = INTRADAY_STRATEGIES.find((item) => item.id === strategyId);
    if (!strategy) return [];
    const fields = [...strategy.fields,
      { key: "allocationPct", label: "투자 비율 (%)", min: 1, max: 100, step: 0.1 },
      { key: "stopLossPct", label: "손절 (%)", min: 0.1, max: 50, step: 0.1 },
      { key: "takeProfitPct", label: "익절 (%)", min: 0.1, max: 100, step: 0.1 },
    ];
    return fields.map((field) => ({ key: field.key, label: field.label,
      minimum: field.min, maximum: field.max, optional: false, isInteger: (field.step ?? 1) === 1,
      defaultValue: (strategy.defaults as Record<string, number>)[field.key] }));
  }, [mode, schema.data, strategyId]);
  return { specs, isLoading: mode === "daily" && schema.isLoading, error: mode === "daily" ? schema.error : null };
}
