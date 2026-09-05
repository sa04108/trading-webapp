import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import {
  backtestCloneBatches, backtestJobs, backtestPreparationJobs, backtestWizardDrafts,
  preparationWizardReferences, preparationPreviewCache,
} from '../../../shared/db/schema.js';
import { preparationInputSchema } from '../../../../shared/schemas/backtest-preparation.js';
import type { BacktestUniversePreview } from './backtest-preparation-orchestrator.js';

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

  /** 과거 준비 행을 정리하기 전에 요청과 고정 일정을 함께 대조해 소유자를 복원한다. */
  initializeLegacyReferences(): void {
    this.database.sqlite.transaction(() => {
      const unmanaged = this.database.db.select({ id: backtestPreparationJobs.id })
        .from(backtestPreparationJobs).where(eq(backtestPreparationJobs.lifecycleManaged, false)).all();
      if (unmanaged.length === 0) {
        // 준비 원본이 전혀 없는 구형 초안도 중복 본문을 남기지 않는다.
        this.database.sqlite.exec(`
          UPDATE backtest_wizard_drafts SET payload_json = json_remove(payload_json, '$.lastPreview')
          WHERE step = 'universe' AND json_valid(payload_json)
            AND json_type(payload_json, '$.lastPreview') IS NOT NULL
        `);
        this.collect();
        return;
      }
      for (const job of this.database.db.select({
        id: backtestJobs.id, requestJson: backtestJobs.requestJson,
        scheduleJson: backtestJobs.universeScheduleJson,
      }).from(backtestJobs).where(isNull(backtestJobs.preparationJobId)).all()) {
        const id = this.findLegacyPreview(job.requestJson, job.scheduleJson);
        if (id) this.database.db.update(backtestJobs).set({ preparationJobId: id })
          .where(eq(backtestJobs.id, job.id)).run();
      }
      for (const batch of this.database.db.select({
        id: backtestCloneBatches.id, requestJson: backtestCloneBatches.requestJson,
        scheduleJson: backtestCloneBatches.universeScheduleJson,
      }).from(backtestCloneBatches).where(isNull(backtestCloneBatches.preparationJobId)).all()) {
        const id = this.findLegacyPreview(batch.requestJson, batch.scheduleJson);
        if (id) this.database.db.update(backtestCloneBatches).set({ preparationJobId: id })
          .where(eq(backtestCloneBatches.id, batch.id)).run();
      }
      const drafts = this.database.db.select().from(backtestWizardDrafts)
        .orderBy(sql`${backtestWizardDrafts.updatedAtMs} DESC`, backtestWizardDrafts.context).all();
      const latestContext = new Map<string, string>();
      for (const draft of drafts) {
        if (!latestContext.has(draft.userId)) latestContext.set(draft.userId, draft.context);
        if (draft.step !== 'universe') continue;
        try {
          const payload = JSON.parse(draft.payloadJson) as {
            universeRule: unknown;
            lastPreview?: { params?: unknown; result?: { scheduleHash?: string } };
          };
          const last = payload.lastPreview;
          if (latestContext.get(draft.userId) === draft.context && !this.getWizard(draft.userId)
            && last?.params && last.result?.scheduleHash) {
            const id = this.findLegacyPreview(JSON.stringify(last.params), null, last.result.scheduleHash);
            if (id) this.database.db.insert(preparationWizardReferences).values({
              userId: draft.userId, context: draft.context, preparationJobId: id,
            }).run();
          }
          this.database.db.update(backtestWizardDrafts).set({
            payloadJson: JSON.stringify({ universeRule: payload.universeRule }),
          }).where(and(
            eq(backtestWizardDrafts.userId, draft.userId),
            eq(backtestWizardDrafts.context, draft.context),
            eq(backtestWizardDrafts.step, draft.step),
          )).run();
        } catch {
          // 손상된 초안은 기존 조회 오류를 유지하며 임의의 준비 결과와 연결하지 않는다.
        }
      }
      // 구형 준비 합계만 있던 DB도 정리 이후 일일 호출 예산을 유지한다.
      this.database.sqlite.exec(`
        INSERT INTO external_api_daily_usage (api, quota_scope, usage_date_kst, calls_used, updated_at_ms)
        SELECT 'DART', 'daily', dart_quota_date_kst, SUM(dart_calls_used), MAX(updated_at_ms)
        FROM backtest_preparation_jobs WHERE dart_quota_date_kst IS NOT NULL
        GROUP BY dart_quota_date_kst
        ON CONFLICT (api, quota_scope, usage_date_kst) DO UPDATE
          SET calls_used = MAX(external_api_daily_usage.calls_used, excluded.calls_used)
      `);
      this.database.db.update(backtestPreparationJobs).set({ lifecycleManaged: true }).run();
      this.collect();
    }).immediate();
  }

  private findLegacyPreview(requestJson: string, scheduleJson: string | null, stagedHash?: string): string | null {
    try {
      const request = preparationInputSchema.parse(JSON.parse(requestJson));
      const candidates = this.database.sqlite.prepare(`
        SELECT id FROM backtest_preparation_jobs
        WHERE status = 'COMPLETED' AND preview_json IS NOT NULL AND json_valid(request_json)
          AND json_extract(request_json, '$.strategyId') = ?
          AND json_extract(request_json, '$.period.from') = ?
          AND json_extract(request_json, '$.period.to') = ?
        ORDER BY created_at_ms DESC, id DESC
      `).all(request.strategyId, request.period.from, request.period.to) as Array<{ id: string }>;
      const expected = scheduleJson === null ? null : canonical(JSON.parse(scheduleJson));
      for (const candidate of candidates) {
        const row = this.database.db.select().from(backtestPreparationJobs)
          .where(eq(backtestPreparationJobs.id, candidate.id)).get()!;
        try {
          if (canonical(preparationInputSchema.parse(JSON.parse(row.requestJson))) !== canonical(request)) continue;
          const preview = JSON.parse(row.previewJson!) as BacktestUniversePreview;
          if (stagedHash !== undefined && stagedHash !== preview.scheduleHash) continue;
          if (expected !== null && expected !== canonical(preview.schedule.map((entry) => ({
            rebalanceDate: entry.rebalanceDate,
            effectiveTradingDate: entry.effectiveDate,
            symbols: entry.members.map((member) => member.symbol),
            members: entry.members,
            excludedNonTradingCount: entry.excludedNonTradingCount,
          })))) continue;
          return row.id;
        } catch {
          // 한 후보의 손상 때문에 다른 정상 완료 결과의 이관을 막지 않는다.
        }
      }
    } catch {
      // 정확한 대응을 입증할 수 없는 과거 백테스트는 기존 고정 데이터만 보존한다.
    }
    return null;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}
