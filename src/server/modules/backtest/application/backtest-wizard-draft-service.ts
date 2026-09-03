import { and, desc, eq } from 'drizzle-orm';
import {
  backtestWizardDraftPayloadSchemas,
  type BacktestWizardPageStep,
  type BacktestWizardDraftPayloadMap,
  type BacktestWizardDraftStep,
} from '../../../../shared/schemas/backtest-wizard-draft.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import { backtestWizardDrafts } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';

export interface BacktestWizardDraft<S extends BacktestWizardDraftStep = BacktestWizardDraftStep> {
  readonly step: S;
  readonly payload: BacktestWizardDraftPayloadMap[S];
  readonly updatedAtMs: number;
}

export interface BacktestWizardResumeCandidate {
  readonly sourceJobId: string | null;
  readonly currentStep: BacktestWizardPageStep;
  readonly updatedAtMs: number;
}

const contextOf = (sourceJobId: string | undefined): string => sourceJobId ?? '';

/** 인증 사용자별 위저드 초안을 SQLite에 단계 단위로 보존한다. */
export class BacktestWizardDraftService {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
  ) {}

  get<S extends BacktestWizardDraftStep>(
    userId: string,
    sourceJobId: string | undefined,
    step: S,
  ): BacktestWizardDraft<S> | null {
    const row = this.db
      .select()
      .from(backtestWizardDrafts)
      .where(and(
        eq(backtestWizardDrafts.userId, userId),
        eq(backtestWizardDrafts.context, contextOf(sourceJobId)),
        eq(backtestWizardDrafts.step, step),
      ))
      .get();
    if (!row) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(row.payloadJson) as unknown;
    } catch (error) {
      throw new Error(`저장된 백테스트 위저드 ${step} 초안 JSON이 손상되었습니다.`, {
        cause: error,
      });
    }
    const parsed = backtestWizardDraftPayloadSchemas[step].safeParse(raw);
    if (!parsed.success) {
      throw new Error(`저장된 백테스트 위저드 ${step} 초안 형식이 올바르지 않습니다.`);
    }
    return {
      step,
      payload: parsed.data as BacktestWizardDraftPayloadMap[S],
      updatedAtMs: row.updatedAtMs,
    };
  }

  /** 사용자가 마지막으로 손댄 미완료 위저드 문맥과 돌아갈 페이지를 찾는다. */
  getResumeCandidate(userId: string): BacktestWizardResumeCandidate | null {
    const latest = this.db
      .select({
        context: backtestWizardDrafts.context,
        updatedAtMs: backtestWizardDrafts.updatedAtMs,
      })
      .from(backtestWizardDrafts)
      .where(eq(backtestWizardDrafts.userId, userId))
      .orderBy(desc(backtestWizardDrafts.updatedAtMs))
      .get();
    if (!latest) return null;

    const sourceJobId = latest.context === '' ? undefined : latest.context;
    const strategy = this.get(userId, sourceJobId, 'strategy');
    return {
      sourceJobId: sourceJobId ?? null,
      currentStep: strategy?.payload.currentStep ?? 'strategy',
      updatedAtMs: latest.updatedAtMs,
    };
  }

  save<S extends BacktestWizardDraftStep>(
    userId: string,
    sourceJobId: string | undefined,
    step: S,
    payload: BacktestWizardDraftPayloadMap[S],
  ): BacktestWizardDraft<S> {
    const updatedAtMs = this.clock.now();
    const values = {
      userId,
      context: contextOf(sourceJobId),
      step,
      payloadJson: JSON.stringify(payload),
      updatedAtMs,
    };
    this.db
      .insert(backtestWizardDrafts)
      .values(values)
      .onConflictDoUpdate({
        target: [
          backtestWizardDrafts.userId,
          backtestWizardDrafts.context,
          backtestWizardDrafts.step,
        ],
        set: { payloadJson: values.payloadJson, updatedAtMs },
      })
      .run();
    return { step, payload, updatedAtMs };
  }

  remove(userId: string, sourceJobId: string | undefined): void {
    this.db
      .delete(backtestWizardDrafts)
      .where(and(
        eq(backtestWizardDrafts.userId, userId),
        eq(backtestWizardDrafts.context, contextOf(sourceJobId)),
      ))
      .run();
  }

  removeAll(userId: string): void {
    this.db
      .delete(backtestWizardDrafts)
      .where(eq(backtestWizardDrafts.userId, userId))
      .run();
  }
}
