import { and, desc, eq, sql } from 'drizzle-orm';
import { readGitCommitSha } from '../../../shared/build-info.js';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import {
  backtestPreparationJobs,
  preparationDataRevision,
  preparationPreviewCache,
} from '../../../shared/db/schema.js';
import type { ReadyPreviewDetails } from './backtest-preparation-execution.js';

// Deployment changes invalidate validation even when source data and request hashes match.
// Bump the protocol for source-runtime changes that affect preview validation.
const VALIDATION_VERSION = `1:${readGitCommitSha()}`;

export class PreparationPreviewCache {
  constructor(private readonly database: DatabaseHandle) {}

  /**
   * Arm invalidation before reading source data. The first subsequent write advances
   * the revision and disarms it; later rows in a bulk import need no revision write.
   * Concurrent validators may re-arm it, but cannot undo an earlier invalidation.
   */
  beginValidation(): number {
    return this.database.sqlite.transaction(() => {
      this.database.db.update(preparationDataRevision).set({ armed: true })
        .where(eq(preparationDataRevision.singleton, 1)).run();
      return this.revision();
    }).immediate();
  }

  revision(): number {
    const row = this.database.db.select().from(preparationDataRevision)
      .where(eq(preparationDataRevision.singleton, 1)).get();
    if (row === undefined) throw new Error('미리보기 데이터 버전 정보가 없습니다.');
    return row.revision;
  }

  /** One SQL snapshot reads both the validation revision and its completed result. */
  get(requestHash: string): ReadyPreviewDetails | null {
    const row = this.database.db.select({
      previewJson: backtestPreparationJobs.previewJson,
      fundamentalSymbolsJson: preparationPreviewCache.fundamentalSymbolsJson,
    }).from(backtestPreparationJobs)
      .innerJoin(preparationPreviewCache, eq(preparationPreviewCache.jobId, backtestPreparationJobs.id))
      .where(and(
        eq(backtestPreparationJobs.requestHash, requestHash),
        eq(backtestPreparationJobs.status, 'COMPLETED'),
        eq(preparationPreviewCache.validationVersion, VALIDATION_VERSION),
        eq(preparationPreviewCache.dataRevision, sql`(
          SELECT revision FROM preparation_data_revision WHERE singleton = 1
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
      return { preview, fundamentalSymbols };
    } catch {
      return null;
    }
  }

  /** Caller holds the completion write transaction and has checked the same revision. */
  store(jobId: string, revision: number, fundamentalSymbols: readonly string[]): void {
    this.database.db.insert(preparationPreviewCache).values({
      jobId,
      dataRevision: revision,
      validationVersion: VALIDATION_VERSION,
      fundamentalSymbolsJson: JSON.stringify(fundamentalSymbols),
    }).onConflictDoUpdate({
      target: preparationPreviewCache.jobId,
      set: {
        dataRevision: revision,
        validationVersion: VALIDATION_VERSION,
        fundamentalSymbolsJson: JSON.stringify(fundamentalSymbols),
      },
    }).run();
  }
}
