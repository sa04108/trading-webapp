import { z } from 'zod';

export const universeCriterionSchema = z.enum([
  'MARKET_CAP', 'VOLUME', 'TRADING_VALUE', 'PER', 'ROE', 'DECLINE',
]);
export type UniverseCriterion = z.infer<typeof universeCriterionSchema>;

export const universeDirectionSchema = z.enum(['HIGH', 'LOW']);
export type UniverseDirection = z.infer<typeof universeDirectionSchema>;

export const LEGACY_STAGE_DIRECTION = {
  MARKET_CAP: 'HIGH',
  VOLUME: 'HIGH',
  TRADING_VALUE: 'HIGH',
  PER: 'LOW',
  ROE: 'HIGH',
  DECLINE: 'LOW',
} as const satisfies Record<UniverseCriterion, UniverseDirection>;

export const PREFERRED_STAGE_DIRECTION = {
  MARKET_CAP: 'HIGH',
  VOLUME: 'HIGH',
  TRADING_VALUE: 'HIGH',
  PER: 'LOW',
  ROE: 'HIGH',
  DECLINE: 'HIGH',
} as const satisfies Record<UniverseCriterion, UniverseDirection>;

const stageLimitSchema = z.number().int().min(1).max(200);

const rawUniverseStageSchema = z.discriminatedUnion('criterion', [
  z.object({ criterion: z.literal('MARKET_CAP'), direction: universeDirectionSchema.optional(), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('VOLUME'), direction: universeDirectionSchema.optional(), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('TRADING_VALUE'), direction: universeDirectionSchema.optional(), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('PER'), direction: universeDirectionSchema.optional(), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('ROE'), direction: universeDirectionSchema.optional(), limit: stageLimitSchema }),
  z.object({
    criterion: z.literal('DECLINE'),
    direction: universeDirectionSchema.optional(),
    limit: stageLimitSchema,
    lookbackTradingDays: z.number().int().min(1).max(252),
  }),
]);

export const universeStageSchema = rawUniverseStageSchema.transform((stage) => ({
  ...stage,
  direction: stage.direction ?? LEGACY_STAGE_DIRECTION[stage.criterion],
}));
export type UniverseStageInput = z.input<typeof universeStageSchema>;
export type UniverseStage = z.output<typeof universeStageSchema>;

export const rebalanceIntervalSchema = z.discriminatedUnion('unit', [
  z.object({ unit: z.literal('NONE'), value: z.literal(1) }),
  z.object({ unit: z.literal('DAY'), value: z.number().int().min(1).max(365) }),
  z.object({ unit: z.literal('WEEK'), value: z.number().int().min(1).max(52) }),
  z.object({ unit: z.literal('MONTH'), value: z.number().int().min(1).max(12) }),
  z.object({ unit: z.literal('YEAR'), value: z.literal(1) }),
]);
export type RebalanceInterval = z.infer<typeof rebalanceIntervalSchema>;

export const universeRuleSchema = z.object({
  markets: z.array(z.enum(['KOSPI', 'KOSDAQ'])).length(1),
  stages: z.array(universeStageSchema).min(1).max(6),
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
