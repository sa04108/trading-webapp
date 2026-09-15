import { and, desc, eq, sql } from 'drizzle-orm';
import { readRuntimeVersions } from '../../../shared/runtime-versions.js';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import {
  backtestPreparationJobs,
  datasetState,
  preparationPreviewCache,
} from '../../../shared/db/schema.js';
import type { ReadyPreviewDetails } from './backtest-preparation-orchestrator.js';

export class PreparationPreviewCache {
  private readonly previewVersion = readRuntimeVersions().previewVersion;

  constructor(private readonly database: DatabaseHandle) {}

  /** 계산 DB는 읽기 전용 스냅샷에서도 같은 원본 버전으로 검증한다. */
  beginValidation(): number { return this.revision(); }

  revision(): number {
    const row = this.database.db.select().from(datasetState)
      .where(eq(datasetState.singleton, 1)).get();
    if (row === undefined) throw new Error('미리보기 데이터 버전 정보가 없습니다.');
    return row.revision;
  }

  /** 제출 직전 쓰기 트랜잭션에서 본문을 다시 읽지 않고 검증 버전만 대조한다. */
  isFresh(preparationJobId: string): boolean {
    return this.database.db.select({ id: backtestPreparationJobs.id }).from(backtestPreparationJobs)
      .innerJoin(preparationPreviewCache, eq(preparationPreviewCache.jobId, backtestPreparationJobs.id))
      .where(and(
        eq(backtestPreparationJobs.id, preparationJobId),
        eq(backtestPreparationJobs.status, 'COMPLETED'),
        eq(preparationPreviewCache.validationVersion, this.previewVersion),
        eq(preparationPreviewCache.dataRevision, sql`(
          SELECT revision FROM dataset_state WHERE singleton = 1
        )`),
      )).get() !== undefined;
  }

  /** 같은 SQL 스냅샷에서 검증 버전과 완료된 본문을 함께 읽는다. */
  get(requestHash: string, preparationJobId?: string): ReadyPreviewDetails | null {
    const row = this.database.db.select({
      jobId: backtestPreparationJobs.id,
      previewJson: backtestPreparationJobs.previewJson,
      fundamentalSymbolsJson: preparationPreviewCache.fundamentalSymbolsJson,
    }).from(backtestPreparationJobs)
      .innerJoin(preparationPreviewCache, eq(preparationPreviewCache.jobId, backtestPreparationJobs.id))
      .where(and(
        eq(backtestPreparationJobs.requestHash, requestHash),
        preparationJobId === undefined ? undefined : eq(backtestPreparationJobs.id, preparationJobId),
        eq(backtestPreparationJobs.status, 'COMPLETED'),
        eq(preparationPreviewCache.validationVersion, this.previewVersion),
        eq(preparationPreviewCache.dataRevision, sql`(
          SELECT revision FROM dataset_state WHERE singleton = 1
        )`),
      ))
      .orderBy(desc(backtestPreparationJobs.createdAtMs))
      .limit(1).get();
    if (!row?.previewJson) return null;
    try {
      const preview = JSON.parse(row.previewJson) as ReadyPreviewDetails['preview'];
      const fundamentalSymbols: unknown = JSON.parse(row.fundamentalSymbolsJson);
      if (!Array.isArray(fundamentalSymbols)
        || !fundamentalSymbols.every((symbol): symbol is string => typeof symbol === 'string')) {
        return null;
      }
      return { preview: { ...preview, preparationJobId: row.jobId }, fundamentalSymbols };
    } catch {
      return null;
    }
  }

  /** 호출자는 완료 쓰기 트랜잭션 안에서 같은 데이터 revision을 확인해야 한다. */
  store(jobId: string, revision: number, fundamentalSymbols: readonly string[]): void {
    this.database.db.insert(preparationPreviewCache).values({
      jobId,
      dataRevision: revision,
      validationVersion: this.previewVersion,
      fundamentalSymbolsJson: JSON.stringify(fundamentalSymbols),
    }).onConflictDoUpdate({
      target: preparationPreviewCache.jobId,
      set: {
        dataRevision: revision,
        validationVersion: this.previewVersion,
        fundamentalSymbolsJson: JSON.stringify(fundamentalSymbols),
      },
    }).run();
  }
}
