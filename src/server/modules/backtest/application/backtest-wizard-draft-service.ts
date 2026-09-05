import { and, desc, eq } from 'drizzle-orm';
import {
  backtestWizardDraftPayloadSchemas,
  type BacktestWizardPageStep,
  type BacktestWizardDraftPayloadMap,
  type BacktestWizardDraftWritePayloadMap,
  type BacktestWizardDraftStep,
} from '../../../../shared/schemas/backtest-wizard-draft.js';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import { backtestJobs, backtestWizardDrafts } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { PreparationReferenceService } from './preparation-reference-service.js';

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

/** 인증 사용자별 입력을 보존하고 현재 미리보기는 서버의 단일 참조에서 복원한다. */
export class BacktestWizardDraftService {
  private readonly references: PreparationReferenceService;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly clock: Clock,
  ) {
    this.references = new PreparationReferenceService(database);
  }

  get<S extends BacktestWizardDraftStep>(
    userId: string,
    sourceJobId: string | undefined,
    step: S,
  ): BacktestWizardDraft<S> | null {
    const context = contextOf(sourceJobId);
    const row = this.database.db.select().from(backtestWizardDrafts).where(and(
      eq(backtestWizardDrafts.userId, userId),
      eq(backtestWizardDrafts.context, context),
      eq(backtestWizardDrafts.step, step),
    )).get();
    if (!row) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(row.payloadJson) as unknown;
      if (step === 'universe' && raw !== null && typeof raw === 'object') {
        raw = { ...raw, lastPreview: this.references.getWizardPreview(userId, context) };
      }
    } catch (error) {
      throw new Error(`저장된 백테스트 위저드 ${step} 초안 JSON이 손상되었습니다.`, { cause: error });
    }
    const parsed = backtestWizardDraftPayloadSchemas[step].safeParse(raw);
    if (!parsed.success) throw new Error(`저장된 백테스트 위저드 ${step} 초안 형식이 올바르지 않습니다.`);
    return { step, payload: parsed.data as BacktestWizardDraftPayloadMap[S], updatedAtMs: row.updatedAtMs };
  }

  /** 다른 사용자의 작성 문맥은 최신 초안 조회에도 포함하지 않는다. */
  getResumeCandidate(userId: string): BacktestWizardResumeCandidate | null {
    const latest = this.database.db.select({
      context: backtestWizardDrafts.context, updatedAtMs: backtestWizardDrafts.updatedAtMs,
    }).from(backtestWizardDrafts).where(eq(backtestWizardDrafts.userId, userId))
      .orderBy(desc(backtestWizardDrafts.updatedAtMs)).get();
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
    payload: BacktestWizardDraftWritePayloadMap[S],
  ): BacktestWizardDraft<S> {
    return this.database.sqlite.transaction(() => {
      const context = contextOf(sourceJobId);
      const updatedAtMs = this.clock.now();
      let stored: unknown = payload;
      if (step === 'universe') {
        const universe = payload as BacktestWizardDraftWritePayloadMap['universe'];
        const requestedId = universe.lastPreview?.preparationJobId;
        const owner = this.references.getWizard(userId);
        // 신규 미리보기는 POST에서 이미 연결한다. 늦은 자동 저장이 새 참조를 되돌리지 않는다.
        // 복제 위저드는 원본 백테스트가 실제 소유한 ID만 최초 연결할 수 있다.
        if (requestedId && !owner && sourceJobId) {
          const source = this.database.db.select({ preparationJobId: backtestJobs.preparationJobId })
            .from(backtestJobs).where(eq(backtestJobs.id, sourceJobId)).get();
          if (source?.preparationJobId === requestedId) {
            this.references.bindWizard(userId, context, requestedId);
          }
        }
        stored = { universeRule: universe.universeRule };
      }
      const values = { userId, context, step, payloadJson: JSON.stringify(stored), updatedAtMs };
      this.database.db.insert(backtestWizardDrafts).values(values).onConflictDoUpdate({
        target: [backtestWizardDrafts.userId, backtestWizardDrafts.context, backtestWizardDrafts.step],
        set: { payloadJson: values.payloadJson, updatedAtMs },
      }).run();
      return this.get(userId, sourceJobId, step)!;
    }).immediate();
  }

  remove(userId: string, sourceJobId: string | undefined): void {
    this.database.sqlite.transaction(() => {
      const context = contextOf(sourceJobId);
      this.database.db.delete(backtestWizardDrafts).where(and(
        eq(backtestWizardDrafts.userId, userId), eq(backtestWizardDrafts.context, context),
      )).run();
      this.references.releaseWizard(userId, context);
    }).immediate();
  }

  removeAll(userId: string): void {
    this.database.sqlite.transaction(() => {
      this.database.db.delete(backtestWizardDrafts).where(eq(backtestWizardDrafts.userId, userId)).run();
      this.references.releaseWizard(userId);
    }).immediate();
  }
}
