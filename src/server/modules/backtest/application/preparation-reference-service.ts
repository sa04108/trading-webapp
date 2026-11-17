import { and, eq, notInArray } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import {
  backtestPreparationJobs,
  preparationPreviewCache,
} from "../../../../runtime/shared/db/operations-schema.js";
import {
  backtestWizardDrafts,
  preparationWizardReferences,
  backtestWizardJobs,
  backtestWizardChildren,
} from "../../../shared/db/preparation-owner-schema.js";
import { preparationInputSchema } from "../../../../shared/schemas/backtest-preparation.js";
import type { BacktestUniversePreview } from "../../../../runtime/modules/backtest/application/backtest-preparation-orchestrator.js";
import { requireEditableWizard } from "./backtest-wizard-state.js";

export class PreparationReferenceError extends Error {
  constructor() {
    super(
      "사용 중인 미리보기가 변경되었거나 삭제되었습니다. 미리보기를 다시 확인하세요.",
    );
    this.name = "PreparationReferenceError";
  }
}

/** 카운터를 복제하지 않고 실제 소유자 행을 조회해 미리보기의 수명을 관리한다. */
export class PreparationReferenceService {
  constructor(private readonly database: DatabaseHandle) {}

  getWizard(userId: string, context?: string) {
    return (
      this.database.db
        .select()
        .from(preparationWizardReferences)
        .where(
          and(
            eq(preparationWizardReferences.userId, userId),
            context === undefined
              ? notInArray(preparationWizardReferences.context, this.database.db.select({ id: backtestWizardJobs.id }).from(backtestWizardJobs))
              : eq(preparationWizardReferences.context, context),
          ),
        )
        .get() ?? null
    );
  }

  bindWizard(userId: string, context: string, preparationJobId: string): void {
    this.database.sqlite
      .transaction(() => {
        const wizard = this.database.db.select().from(backtestWizardJobs).where(eq(backtestWizardJobs.id, context)).get();
        if (wizard) requireEditableWizard(this.database, userId, context);
        else {
          // 이전 API의 단일 작성 문맥은 유지하되 새 위저드의 참조는 건드리지 않는다.
          this.database.db.delete(preparationWizardReferences).where(and(
            eq(preparationWizardReferences.userId, userId),
            notInArray(preparationWizardReferences.context, this.database.db.select({ id: backtestWizardJobs.id }).from(backtestWizardJobs)),
          )).run();
        }
        this.requirePreparation(preparationJobId);
        this.database.db
          .insert(preparationWizardReferences)
          .values({
            userId,
            context,
            preparationJobId,
          })
          .onConflictDoUpdate({
            target: [preparationWizardReferences.userId, preparationWizardReferences.context],
            set: { preparationJobId },
          })
          .run();
        if (wizard) {
          this.database.db.insert(backtestWizardChildren).values({ wizardId: context, kind: "preparation", jobId: preparationJobId }).onConflictDoNothing().run();
          this.database.db.update(backtestWizardJobs).set({ currentStep: "universe", backtestJobId: null })
            .where(eq(backtestWizardJobs.id, context)).run();
        }
        this.database.db
          .update(backtestPreparationJobs)
          .set({ lifecycleManaged: true })
          .where(eq(backtestPreparationJobs.id, preparationJobId))
          .run();
        this.collect();
      })
      .immediate();
  }

  releaseWizard(userId: string, context?: string): void {
    this.database.sqlite
      .transaction(() => {
        this.database.db
          .delete(preparationWizardReferences)
          .where(
            and(
              eq(preparationWizardReferences.userId, userId),
              context === undefined
                ? undefined
                : eq(preparationWizardReferences.context, context),
            ),
          )
          .run();
        this.collect();
      })
      .immediate();
  }

  requirePreparation(id: string, completed = false): void {
    const row = this.database.db
      .select({
        id: backtestPreparationJobs.id,
        status: backtestPreparationJobs.status,
      })
      .from(backtestPreparationJobs)
      .where(eq(backtestPreparationJobs.id, id))
      .get();
    if (!row || (completed && row.status !== "COMPLETED"))
      throw new PreparationReferenceError();
  }

  /** 백테스트 행을 저장한 트랜잭션 안에서만 위저드 소유권을 넘긴다. */
  finishWizard(
    userId: string,
    context: string,
    preparationJobId: string,
    backtestJobId?: string,
  ): void {
    const wizard = this.database.db.select().from(backtestWizardJobs).where(eq(backtestWizardJobs.id, context)).get();
    if (wizard) {
      requireEditableWizard(this.database, userId, context);
      if (!backtestJobId) throw new Error("위저드 실행에는 백테스트 ID가 필요합니다.");
      this.database.db.insert(backtestWizardChildren).values({ wizardId: context, kind: "backtest", jobId: backtestJobId }).run();
      this.database.db.update(backtestWizardJobs).set({ backtestJobId, currentStep: "run", status: "QUEUED" })
        .where(eq(backtestWizardJobs.id, context)).run();
      return;
    }
    const owner = this.getWizard(userId, context);
    if (owner && owner.preparationJobId !== preparationJobId) return;
    this.database.db
      .delete(backtestWizardDrafts)
      .where(
        and(
          eq(backtestWizardDrafts.userId, userId),
          eq(backtestWizardDrafts.context, context),
        ),
      )
      .run();
    if (owner) this.releaseWizard(userId, context);
  }

  hasConsumers(preparationJobId: string): boolean {
    return Boolean(this.database.sqlite.prepare(`SELECT 1 FROM preparation_wizard_references WHERE preparation_job_id=@id
      UNION ALL SELECT 1 FROM backtest_jobs WHERE preparation_job_id=@id
      UNION ALL SELECT 1 FROM backtest_clone_batches WHERE preparation_job_id=@id
      UNION ALL SELECT 1 FROM backtest_validation_trials WHERE preparation_job_id=@id
      UNION ALL SELECT 1 FROM configuration_search_items WHERE preparation_job_id=@id
      UNION ALL SELECT 1 FROM backtest_refresh_jobs WHERE preparation_job_id=@id LIMIT 1`).get({ id: preparationJobId }));
  }

  collect(): number {
    return this.database.sqlite
      .prepare(
        `
      DELETE FROM backtest_preparation_jobs
      WHERE lifecycle_managed = 1 AND status IN ('COMPLETED', 'FAILED', 'CANCELLED')
        AND NOT EXISTS (SELECT 1 FROM backtest_jobs b
          WHERE b.preparation_job_id = backtest_preparation_jobs.id)
        AND NOT EXISTS (SELECT 1 FROM backtest_clone_batches b
          WHERE b.preparation_job_id = backtest_preparation_jobs.id)
        AND NOT EXISTS (SELECT 1 FROM preparation_wizard_references w
          WHERE w.preparation_job_id = backtest_preparation_jobs.id)
        AND NOT EXISTS (SELECT 1 FROM backtest_validation_trials v
          WHERE v.preparation_job_id = backtest_preparation_jobs.id)
        AND NOT EXISTS (SELECT 1 FROM backtest_refresh_jobs r
          WHERE r.preparation_job_id = backtest_preparation_jobs.id)
        AND NOT EXISTS (SELECT 1 FROM configuration_search_items s
          WHERE s.preparation_job_id = backtest_preparation_jobs.id)
    `,
      )
      .run().changes;
  }

  /** 원본은 서버의 준비 행에서 읽는다. 초안에는 큰 미리보기 본문을 복사하지 않는다. */
  getWizardPreview(userId: string, context: string) {
    const owner = this.getWizard(userId, context);
    if (!owner) return null;
    const row = this.database.db
      .select()
      .from(backtestPreparationJobs)
      .where(eq(backtestPreparationJobs.id, owner.preparationJobId))
      .get();
    if (row?.status !== "COMPLETED" || !row.previewJson) return null;
    try {
      const params = preparationInputSchema.parse(JSON.parse(row.requestJson));
      const result = JSON.parse(row.previewJson) as BacktestUniversePreview;
      if (
        !Array.isArray(result.schedule) ||
        !Array.isArray(result.unionSymbols)
      )
        return null;
      const receipt = this.database.db
        .select()
        .from(preparationPreviewCache)
        .where(eq(preparationPreviewCache.jobId, row.id))
        .get();
      const fundamentalSymbols: unknown = receipt
        ? JSON.parse(receipt.fundamentalSymbolsJson)
        : undefined;
      return {
        params,
        result: {
          ...result,
          preparationJobId: row.id,
          ...(Array.isArray(fundamentalSymbols) &&
          fundamentalSymbols.every((symbol) => typeof symbol === "string")
            ? { fundamentalSymbols: fundamentalSymbols as string[] }
            : {}),
        },
      };
    } catch {
      return null;
    }
  }
}
