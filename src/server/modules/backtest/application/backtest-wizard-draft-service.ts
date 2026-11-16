import { and, eq, notInArray } from "drizzle-orm";
import {
  backtestWizardDraftPayloadSchemas,
  type BacktestWizardDraftPayloadMap,
  type BacktestWizardDraftWritePayloadMap,
  type BacktestWizardDraftStep,
} from "../../../../shared/schemas/backtest-wizard-draft.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { backtestJobs } from "../../../../runtime/shared/db/operations-schema.js";
import { backtestWizardDrafts, backtestWizardJobs } from "../../../shared/db/preparation-owner-schema.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import { PreparationReferenceService } from "./preparation-reference-service.js";
import { BacktestWizardError, requireEditableWizard } from "./backtest-wizard-state.js";

export interface BacktestWizardDraft<
  S extends BacktestWizardDraftStep = BacktestWizardDraftStep,
> {
  readonly step: S;
  readonly payload: BacktestWizardDraftPayloadMap[S];
  readonly updatedAtMs: number;
}

const contextOf = (sourceJobId: string | undefined): string =>
  sourceJobId ?? "";

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
    const row = this.database.db
      .select()
      .from(backtestWizardDrafts)
      .where(
        and(
          eq(backtestWizardDrafts.userId, userId),
          eq(backtestWizardDrafts.context, context),
          eq(backtestWizardDrafts.step, step),
        ),
      )
      .get();
    if (!row) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(row.payloadJson) as unknown;
      if (step === "universe" && raw !== null && typeof raw === "object") {
        raw = {
          ...raw,
          lastPreview: this.references.getWizardPreview(userId, context),
        };
      }
    } catch (error) {
      throw new Error(
        `저장된 백테스트 위저드 ${step} 초안 JSON이 손상되었습니다.`,
        { cause: error },
      );
    }
    const parsed = backtestWizardDraftPayloadSchemas[step].safeParse(raw);
    if (!parsed.success)
      throw new Error(
        `저장된 백테스트 위저드 ${step} 초안 형식이 올바르지 않습니다.`,
      );
    return {
      step,
      payload: parsed.data as BacktestWizardDraftPayloadMap[S],
      updatedAtMs: row.updatedAtMs,
    };
  }

  save<S extends BacktestWizardDraftStep>(
    userId: string,
    sourceJobId: string | undefined,
    step: S,
    payload: BacktestWizardDraftWritePayloadMap[S],
  ): BacktestWizardDraft<S> {
    return this.database.sqlite
      .transaction(() => {
        const context = contextOf(sourceJobId);
        const wizard = this.database.db.select().from(backtestWizardJobs).where(eq(backtestWizardJobs.id, context)).get();
        if (wizard) requireEditableWizard(this.database, userId, context);
        const updatedAtMs = this.clock.now();
        let stored: unknown = payload;
        if (step === "universe") {
          const universe =
            payload as BacktestWizardDraftWritePayloadMap["universe"];
          const requestedId = universe.lastPreview?.preparationJobId;
          const owner = this.references.getWizard(userId, context);
          // 신규 미리보기는 POST에서 이미 연결한다. 늦은 자동 저장이 새 참조를 되돌리지 않는다.
          // 복제 위저드는 원본 백테스트가 실제 소유한 ID만 최초 연결할 수 있다.
          const cloneSourceId = wizard?.sourceJobId ?? sourceJobId;
          if (requestedId && !owner && cloneSourceId) {
            const source = this.database.db
              .select({ preparationJobId: backtestJobs.preparationJobId })
              .from(backtestJobs)
              .where(eq(backtestJobs.id, cloneSourceId))
              .get();
            if (source?.preparationJobId === requestedId) {
              this.references.bindWizard(userId, context, requestedId);
            }
          }
          stored = { universeRule: universe.universeRule };
        }
        const values = {
          userId,
          context,
          step,
          payloadJson: JSON.stringify(stored),
          updatedAtMs,
        };
        this.database.db
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
        if (wizard) {
          const strategy = step === "strategy" ? payload as BacktestWizardDraftWritePayloadMap["strategy"] : null;
          this.database.db.update(backtestWizardJobs).set({ updatedAtMs,
            ...(strategy?.currentStep ? { currentStep: strategy.currentStep } : {}),
          }).where(eq(backtestWizardJobs.id, context)).run();
        }
        return this.get(userId, sourceJobId, step)!;
      })
      .immediate();
  }

  remove(userId: string, sourceJobId: string | undefined): void {
    if (sourceJobId && this.database.db.select().from(backtestWizardJobs).where(eq(backtestWizardJobs.id, sourceJobId)).get())
      throw new BacktestWizardError("위저드 작업은 작업 취소 API로 종료하세요.", 409);
    this.database.sqlite
      .transaction(() => {
        const context = contextOf(sourceJobId);
        this.database.db
          .delete(backtestWizardDrafts)
          .where(
            and(
              eq(backtestWizardDrafts.userId, userId),
              eq(backtestWizardDrafts.context, context),
            ),
          )
          .run();
        this.references.releaseWizard(userId, context);
      })
      .immediate();
  }

  removeAll(userId: string): void {
    this.database.sqlite
      .transaction(() => {
        this.database.db
          .delete(backtestWizardDrafts)
          .where(and(eq(backtestWizardDrafts.userId, userId), notInArray(backtestWizardDrafts.context,
            this.database.db.select({ id: backtestWizardJobs.id }).from(backtestWizardJobs))))
          .run();
        // 이전 API의 일괄 초기화가 독립 위저드 작업을 취소하거나 참조를 지우지 않는다.
        const legacy = this.database.sqlite.prepare(`SELECT context FROM preparation_wizard_references
          WHERE user_id=? AND context NOT IN (SELECT id FROM backtest_wizard_jobs)`).all(userId) as { context: string }[];
        for (const row of legacy) this.references.releaseWizard(userId, row.context);
      })
      .immediate();
  }
}
