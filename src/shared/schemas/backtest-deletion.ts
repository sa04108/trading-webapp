import { z } from "zod";

export const backtestDeletionRequestSchema = z.object({
  mode: z.enum(["daily", "intraday"]),
  ids: z.array(z.string().min(1).max(200)).min(1).max(100),
}).strict();
export const backtestDeletionConfirmSchema = backtestDeletionRequestSchema.extend({ token: z.string().length(64) });
export interface BacktestDeletionPreview {
  backtestCount: number;
  configurationSearchCount: number;
  periodValidationCount: number;
  blockers: string[];
  token: string;
}
