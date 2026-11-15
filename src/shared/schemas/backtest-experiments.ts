import type { PeriodValidationConfig } from "./period-validation.js";

export interface ExperimentReturnDistribution {
  /** 유효한 완료 결과만 집계하며 두 건 미만의 표준편차는 null이다. */
  count: number;
  mean: number | null;
  sampleStdDev: number | null;
}

export interface BacktestHistoryExtras {
  jobId: string;
  benchmarkExcessReturnPct: number | null;
  seed: {
    batchCount: number;
    activeCount: number;
    completedCount: number;
    returns: ExperimentReturnDistribution;
  };
  validation: {
    experimentCount: number;
    activeCount: number;
    completedCount: number;
    /** 실험별 OOS 구간 수익률 평균의 분포. 회차를 연속 운용으로 합산하지 않는다. */
    returns: ExperimentReturnDistribution;
    modes: Record<PeriodValidationConfig["mode"], number>;
  };
}

export interface BacktestBreadcrumbEntry {
  label: string;
  href?: string;
  description?: string;
}

export interface BacktestLineage {
  items: BacktestBreadcrumbEntry[];
  kind: "original" | "clone" | "seed" | "validation" | "unknown";
  roleLabel: string;
  /** 상위 기록이 없거나 연결이 손상되면 직접 실행으로 단정하지 않는다. */
  complete: boolean;
}
