import { z } from 'zod';
import { benchmarkIdSchema } from './benchmark.js';
import { universeRuleSchema } from './universe-rule.js';

/**
 * 백테스트 위저드가 서버에 따로 저장하는 입력 단계.
 * 검토·실행은 앞 단계 입력에서 파생되므로 별도 payload를 만들지 않는다.
 */
export const BACKTEST_WIZARD_DRAFT_STEPS = [
  'strategy',
  'period',
  'universe',
  'capital',
] as const;

export const backtestWizardDraftStepSchema = z.enum(BACKTEST_WIZARD_DRAFT_STEPS);
export type BacktestWizardDraftStep = z.infer<typeof backtestWizardDraftStepSchema>;

const formTextSchema = z.string().max(256);
const parameterKeySchema = z.string().min(1).max(128);

export const backtestWizardStrategyDraftSchema = z.object({
  strategyId: z.string().min(1).max(128).nullable(),
  parameters: z.record(parameterKeySchema, formTextSchema),
});

export const backtestWizardPeriodDraftSchema = z.object({
  // 작성 중에는 빈 문자열도 정상 상태다. 완성된 날짜 검증은 기존 단계 게이트가 맡는다.
  from: z.string().max(10),
  to: z.string().max(10),
  benchmarkId: benchmarkIdSchema,
  /** 이 입력 조합으로 벤치마크 coverage를 확인했다는 UI 게이트 원재료. */
  benchmarkCoverageVerifiedFor: z.string().max(160).nullable(),
});

const previewParamsSchema = z.object({
  universeRule: universeRuleSchema,
  period: z.object({ from: z.string().max(10), to: z.string().max(10) }),
  strategyId: z.string().max(128),
  parameters: z.record(parameterKeySchema, z.unknown()),
});

const previewResultSchema = z.object({
  schedule: z.array(z.object({
    rebalanceDate: z.string().max(10),
    effectiveDate: z.string().max(10),
    members: z.array(z.object({ symbol: z.string().min(1).max(32) })).max(200),
  })).max(20_000),
  unionSymbols: z.array(z.string().min(1).max(32)).max(200),
  fundamentalSymbols: z.array(z.string().min(1).max(32)).max(200).optional(),
  scheduleHash: z.string().min(1).max(128),
  uncoveredDates: z.array(z.string().max(10)).max(20_000),
  periodCovered: z.boolean(),
  missingCandleSymbols: z.array(z.string().min(1).max(32)).max(200),
  warnings: z.array(z.string().max(2_000)).max(1_000),
});

export const backtestWizardUniverseDraftSchema = z.object({
  universeRule: universeRuleSchema,
  /**
   * 성공한 미리보기와 그 입력을 함께 보존한다. 현재 입력과 같은지는 복원 후에도
   * `sameUniverseParams`로 다시 판정하므로, 낡은 성공이 새 입력의 게이트를 열지 않는다.
   */
  lastPreview: z.object({
    params: previewParamsSchema,
    result: previewResultSchema,
  }).nullable(),
});

export const backtestWizardCapitalDraftSchema = z.object({
  initialCash: formTextSchema,
  maxPositions: formTextSchema,
  commissionProfileId: formTextSchema,
  slippageProfileId: formTextSchema,
  randomSeed: formTextSchema,
});

export const backtestWizardDraftPayloadSchemas = {
  strategy: backtestWizardStrategyDraftSchema,
  period: backtestWizardPeriodDraftSchema,
  universe: backtestWizardUniverseDraftSchema,
  capital: backtestWizardCapitalDraftSchema,
} as const;

export interface BacktestWizardDraftPayloadMap {
  strategy: z.infer<typeof backtestWizardStrategyDraftSchema>;
  period: z.infer<typeof backtestWizardPeriodDraftSchema>;
  universe: z.infer<typeof backtestWizardUniverseDraftSchema>;
  capital: z.infer<typeof backtestWizardCapitalDraftSchema>;
}

export const backtestWizardDraftContextSchema = z.object({
  /** 없으면 신규 작성, 있으면 해당 원본을 재설정 복제하는 작성 문맥이다. */
  sourceJobId: z.string().min(1).max(128).optional(),
});
