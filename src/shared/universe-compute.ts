import { z } from "zod";
import { isoDateSchema } from "./schemas/backtest-request.js";
import { universeRuleSchema } from "./schemas/universe-rule.js";

/** 원본 기간을 보존하고 리밸런스 날짜만 분할한다. 보유 상태는 이 경계를 넘지 않는다. */
export const universeComputeInputSchema = z.object({
  rule: universeRuleSchema,
  period: z.object({ from: isoDateSchema, to: isoDateSchema }),
  rebalanceDates: z.array(isoDateSchema).min(1).max(6),
  excludedSymbols: z.array(z.string().regex(/^[0-9A-Z]{6}$/)).max(10000),
});
export type UniverseComputeInput = z.infer<typeof universeComputeInputSchema>;

export const UNIVERSE_COMPUTE_TIMEOUT_MS = 120_000;
export const UNIVERSE_COMPUTE_MAX_PENDING = 4;
export const universeComputeReplySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("COMPLETED"), resultJson: z.string().max(8 * 1024 * 1024) }),
  z.object({ status: z.literal("UNAVAILABLE") }),
  z.object({ status: z.literal("FAILED"), error: z.string().max(2000) }),
]);
export type UniverseComputeReply = z.infer<typeof universeComputeReplySchema>;
