import { and, eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../../../../runtime/shared/db/database.js';
import { backtestPreparationJobs, preparationPreviewCache } from '../../../../runtime/shared/db/operations-schema.js';
import { backtestWizardDrafts, preparationWizardReferences } from '../../../shared/db/preparation-owner-schema.js';
import { preparationInputSchema } from '../../../../shared/schemas/backtest-preparation.js';
import type { BacktestUniversePreview } from '../../../../runtime/modules/backtest/application/backtest-preparation-orchestrator.js';

export class PreparationReferenceError extends Error {
  constructor() {
    super('사용 중인 미리보기가 변경되었거나 삭제되었습니다. 미리보기를 다시 확인하세요.');
    this.name = 'PreparationReferenceError';
  }
}

/** 카운터를 복제하지 않고 실제 소유자 행을 조회해 미리보기의 수명을 관리한다. */
export class PreparationReferenceService {
  constructor(private readonly database: DatabaseHandle) {}

  getWizard(userId: string, context?: string) {
    return this.database.db.select().from(preparationWizardReferences).where(and(
      eq(preparationWizardReferences.userId, userId),
      context === undefined ? undefined : eq(preparationWizardReferences.context, context),
    )).get() ?? null;
  }

  bindWizard(userId: string, context: string, preparationJobId: string): void {
    this.database.sqlite.transaction(() => {
      this.requirePreparation(preparationJobId);
      this.database.db.insert(preparationWizardReferences).values({
        userId, context, preparationJobId,
      }).onConflictDoUpdate({
        target: preparationWizardReferences.userId,
        set: { context, preparationJobId },
      }).run();
      this.database.db.update(backtestPreparationJobs).set({ lifecycleManaged: true })
        .where(eq(backtestPreparationJobs.id, preparationJobId)).run();
      this.collect();
    }).immediate();
  }

  releaseWizard(userId: string, context?: string): void {
    this.database.sqlite.transaction(() => {
      this.database.db.delete(preparationWizardReferences).where(and(
        eq(preparationWizardReferences.userId, userId),
        context === undefined ? undefined : eq(preparationWizardReferences.context, context),
      )).run();
      this.collect();
    }).immediate();
  }

  requirePreparation(id: string, completed = false): void {
    const row = this.database.db.select({ id: backtestPreparationJobs.id, status: backtestPreparationJobs.status })
      .from(backtestPreparationJobs).where(eq(backtestPreparationJobs.id, id)).get();
    if (!row || (completed && row.status !== 'COMPLETED')) throw new PreparationReferenceError();
  }

  /** 백테스트 행을 저장한 트랜잭션 안에서만 위저드 소유권을 넘긴다. */
  finishWizard(userId: string, context: string, preparationJobId: string): void {
    const owner = this.getWizard(userId, context);
    if (owner && owner.preparationJobId !== preparationJobId) return;
    this.database.db.delete(backtestWizardDrafts).where(and(
      eq(backtestWizardDrafts.userId, userId), eq(backtestWizardDrafts.context, context),
    )).run();
    if (owner) this.releaseWizard(userId, context);
  }

  collect(): number {
    return this.database.sqlite.prepare(`
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
    `).run().changes;
  }

  /** 원본은 서버의 준비 행에서 읽는다. 초안에는 큰 미리보기 본문을 복사하지 않는다. */
  getWizardPreview(userId: string, context: string) {
    const owner = this.getWizard(userId, context);
    if (!owner) return null;
    const row = this.database.db.select().from(backtestPreparationJobs)
      .where(eq(backtestPreparationJobs.id, owner.preparationJobId)).get();
    if (row?.status !== 'COMPLETED' || !row.previewJson) return null;
    try {
      const params = preparationInputSchema.parse(JSON.parse(row.requestJson));
      const result = JSON.parse(row.previewJson) as BacktestUniversePreview;
      if (!Array.isArray(result.schedule) || !Array.isArray(result.unionSymbols)) return null;
      const receipt = this.database.db.select().from(preparationPreviewCache)
        .where(eq(preparationPreviewCache.jobId, row.id)).get();
      const fundamentalSymbols: unknown = receipt ? JSON.parse(receipt.fundamentalSymbolsJson) : undefined;
      return { params, result: {
        ...result, preparationJobId: row.id,
        ...(Array.isArray(fundamentalSymbols) && fundamentalSymbols.every((symbol) => typeof symbol === 'string')
          ? { fundamentalSymbols: fundamentalSymbols as string[] } : {}),
      } };
    } catch {
      return null;
    }
  }

}
