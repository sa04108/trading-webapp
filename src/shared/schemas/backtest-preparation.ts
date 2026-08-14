import { z } from 'zod';
import { isoDateSchema } from './backtest-request.js';
import { universeRuleSchema } from './universe-rule.js';

/** Durable preparation jobs store this request subset, not a full backtest request. */
export const preparationInputSchema = z.object({
  universeRule: universeRuleSchema,
  period: z.object({
    from: isoDateSchema,
    to: isoDateSchema,
  }),
  strategyId: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

export type PreparationInput = z.infer<typeof preparationInputSchema>;
