import { z } from "zod";
import { periodValidationConfigSchema } from "./period-validation.js";

export const backtestRefreshActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CLONE") }),
  z.object({ kind: z.literal("RANDOM_SEEDS"), count: z.number().int().min(1).max(100) }),
  z.object({ kind: z.literal("PERIOD_VALIDATION"), config: periodValidationConfigSchema }),
]);

export type BacktestRefreshAction = z.infer<typeof backtestRefreshActionSchema>;
export type BacktestRefreshStatus = "QUEUED" | "PREPARING" | "SUBMITTING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface BacktestRefreshJob {
  readonly id: string;
  readonly sourceJobId: string;
  readonly action: BacktestRefreshAction;
  readonly status: BacktestRefreshStatus;
  readonly preparationJobId: string | null;
  readonly message: string;
  readonly error: string | null;
  readonly resultHref: string | null;
  readonly createdAtMs: number;
  readonly completedAtMs: number | null;
}

export function backtestRefreshActionLabel(action: BacktestRefreshAction): string {
  switch (action.kind) {
    case "CLONE": return "백테스트 복제";
    case "RANDOM_SEEDS": return `난수 복제 · ${action.count}회`;
    case "PERIOD_VALIDATION": return "기간검증";
  }
}

export function isBacktestRefreshFinished(status: BacktestRefreshStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}
