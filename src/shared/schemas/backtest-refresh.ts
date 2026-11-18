import { z } from "zod";
import { periodValidationConfigSchema } from "./period-validation.js";

export const backtestRefreshActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CLONE") }),
  z.object({ kind: z.literal("PERIOD_VALIDATION"), config: periodValidationConfigSchema }),
]);

export type BacktestRefreshAction = z.infer<typeof backtestRefreshActionSchema>;

/** 이전 버전에서 이미 접수한 작업의 조회·복구에만 사용하며 신규 요청에는 허용하지 않는다. */
export const savedBacktestRefreshActionSchema = z.discriminatedUnion("kind", [
  ...backtestRefreshActionSchema.options,
  z.object({ kind: z.literal("RANDOM_SEEDS"), count: z.number().int().min(1).max(100) }),
]);
export type SavedBacktestRefreshAction = z.infer<typeof savedBacktestRefreshActionSchema>;
export type BacktestRefreshStatus = "QUEUED" | "PREPARING" | "SUBMITTING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface BacktestRefreshJob {
  readonly id: string;
  readonly sourceJobId: string;
  readonly action: SavedBacktestRefreshAction;
  readonly status: BacktestRefreshStatus;
  readonly preparationJobId: string | null;
  readonly message: string;
  readonly error: string | null;
  readonly resultHref: string | null;
  readonly createdAtMs: number;
  readonly completedAtMs: number | null;
}

export function backtestRefreshActionLabel(action: SavedBacktestRefreshAction): string {
  switch (action.kind) {
    case "CLONE": return "백테스트 복제";
    case "RANDOM_SEEDS": return `이전 설정 탐색 실험 · ${action.count}회`;
    case "PERIOD_VALIDATION": return "기간검증";
  }
}

export function isBacktestRefreshFinished(status: BacktestRefreshStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}
