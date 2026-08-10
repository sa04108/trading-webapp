import { z } from 'zod';

export const universeCriterionSchema = z.enum([
  'MARKET_CAP', 'VOLUME', 'TRADING_VALUE', 'PER', 'DECLINE',
]);
export type UniverseCriterion = z.infer<typeof universeCriterionSchema>;

const stageLimitSchema = z.number().int().min(1).max(200);

export const universeStageSchema = z.discriminatedUnion('criterion', [
  z.object({ criterion: z.literal('MARKET_CAP'), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('VOLUME'), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('TRADING_VALUE'), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('PER'), limit: stageLimitSchema }),
  z.object({
    criterion: z.literal('DECLINE'),
    limit: stageLimitSchema,
    lookbackTradingDays: z.number().int().min(1).max(252),
  }),
]);
export type UniverseStage = z.infer<typeof universeStageSchema>;

export const rebalanceIntervalSchema = z.discriminatedUnion('unit', [
  z.object({ unit: z.literal('DAY'), value: z.number().int().min(1).max(365) }),
  z.object({ unit: z.literal('WEEK'), value: z.number().int().min(1).max(52) }),
  z.object({ unit: z.literal('MONTH'), value: z.number().int().min(1).max(12) }),
  z.object({ unit: z.literal('YEAR'), value: z.literal(1) }),
]);
export type RebalanceInterval = z.infer<typeof rebalanceIntervalSchema>;

export const universeRuleSchema = z.object({
  markets: z.array(z.enum(['KOSPI', 'KOSDAQ'])).length(1),
  stages: z.array(universeStageSchema).min(1).max(5),
  rebalanceInterval: rebalanceIntervalSchema,
}).superRefine((rule, ctx) => {
  const seen = new Set<UniverseCriterion>();
  rule.stages.forEach((stage, index) => {
    if (seen.has(stage.criterion)) {
      ctx.addIssue({
        code: 'custom',
        path: ['stages', index, 'criterion'],
        message: '같은 정렬 기준은 한 번만 사용할 수 있습니다.',
      });
    }
    if (index > 0 && stage.limit > rule.stages[index - 1]!.limit) {
      ctx.addIssue({
        code: 'custom',
        path: ['stages', index, 'limit'],
        message: '다음 단계 N은 직전 단계 N 이하여야 합니다.',
      });
    }
    seen.add(stage.criterion);
  });
});
export type UniverseRule = z.infer<typeof universeRuleSchema>;
