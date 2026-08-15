import { randomInt } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import { benchmarkPinSchema, type BenchmarkPin } from '../../../../shared/schemas/benchmark.js';
import {
  backtestRequestSchema,
  MAX_RANDOM_SEED,
  type BacktestRequest,
} from '../../../../shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../../../../shared/schemas/provenance-pin.js';
import type { Clock } from '../../../shared/clock.js';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import {
  backtestCloneBatchItems,
  backtestCloneBatches,
} from '../../../shared/db/schema.js';
import { newId } from '../../../shared/ids.js';
import type { ConsumedVersionSnapshot } from '../../market-data/application/symbol-service.js';
import type { LegacyUniverseScheduleEntry } from './universe-rule-resolver.js';
import type { BacktestJobRow, JobQueue } from './job-queue.js';

export type SeedCloneBatchRow = typeof backtestCloneBatches.$inferSelect;
export type SeedCloneBatchItemRow = typeof backtestCloneBatchItems.$inferSelect;

export interface SeedCloneBatchSnapshot {
  readonly request: BacktestRequest;
  readonly schedule: readonly LegacyUniverseScheduleEntry[];
  readonly universe: ConsumedVersionSnapshot;
  readonly provenancePin: ProvenancePin;
  readonly benchmark: { readonly pin: BenchmarkPin; readonly hash: string };
  readonly warnings: readonly string[];
}

export interface SeedCloneBatchDetail {
  readonly batch: SeedCloneBatchRow;
  readonly items: ReadonlyArray<{
    readonly item: SeedCloneBatchItemRow;
    readonly job: BacktestJobRow | null;
  }>;
}

/**
 * 1~100개 난수 시드 복제를 기존 QUEUED 상한 안에서 순차 승격하는 영속 서비스.
 * PENDING item은 가벼운 SQLite 행이라 100개를 미리 저장해도 워커 큐와 리소스 가드를
 * 우회하지 않는다. 실제 backtest_jobs는 빈 QUEUED 슬롯 수만큼만 생성한다.
 */
export class SeedCloneBatchService {
  constructor(
    private readonly database: DatabaseHandle,
    private readonly queue: JobQueue,
    private readonly maxQueuedBacktests: number,
    private readonly clock: Clock,
  ) {}

  create(sourceJobId: string, count: number, snapshot: SeedCloneBatchSnapshot): SeedCloneBatchDetail {
    const batchId = newId('btb');
    const seeds = uniqueSeeds(count, snapshot.request.randomSeed);
    this.database.db.transaction((tx) => {
      tx.insert(backtestCloneBatches).values({
        id: batchId,
        sourceJobId,
        strategyId: snapshot.request.strategyId,
        status: 'ACTIVE',
        totalCount: count,
        requestJson: JSON.stringify(snapshot.request),
        universeScheduleJson: JSON.stringify(snapshot.schedule),
        provenancePinJson: JSON.stringify(snapshot.provenancePin),
        universeJson: JSON.stringify(snapshot.universe.entries),
        universeHash: snapshot.universe.hash,
        benchmarkJson: JSON.stringify(snapshot.benchmark.pin),
        benchmarkHash: snapshot.benchmark.hash,
        submitWarningsJson: snapshot.warnings.length > 0 ? JSON.stringify(snapshot.warnings) : null,
        createdAtMs: this.clock.now(),
      }).run();
      tx.insert(backtestCloneBatchItems).values(
        seeds.map((randomSeed, ordinal) => ({
          id: newId('bti'),
          batchId,
          ordinal,
          randomSeed,
          state: 'PENDING',
        })),
      ).run();
    });
    this.pump();
    return this.get(batchId)!;
  }

  /** 서버 부팅 복구와 job 상태 이벤트에서 호출해 열린 큐 슬롯을 채운다. */
  pump(): void {
    let available = this.maxQueuedBacktests - this.queue.countByStatus(['QUEUED']);
    if (available <= 0) return;

    const batches = this.database.db
      .select()
      .from(backtestCloneBatches)
      .where(eq(backtestCloneBatches.status, 'ACTIVE'))
      .orderBy(asc(backtestCloneBatches.createdAtMs))
      .all();

    for (const batch of batches) {
      if (available <= 0) break;
      let snapshot: SeedCloneBatchSnapshot;
      try {
        snapshot = parseSnapshot(batch);
      } catch (error) {
        this.database.db.update(backtestCloneBatches).set({
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          completedAtMs: this.clock.now(),
        }).where(eq(backtestCloneBatches.id, batch.id)).run();
        continue;
      }

      const pending = this.database.db
        .select()
        .from(backtestCloneBatchItems)
        .where(eq(backtestCloneBatchItems.batchId, batch.id))
        .orderBy(asc(backtestCloneBatchItems.ordinal))
        .all()
        .filter((item) => item.state === 'PENDING')
        .slice(0, available);

      for (const item of pending) {
        this.database.sqlite.transaction(() => {
          const current = this.database.db
            .select()
            .from(backtestCloneBatchItems)
            .where(eq(backtestCloneBatchItems.id, item.id))
            .get();
          if (current?.state !== 'PENDING') return;
          const job = this.queue.enqueue(
            { ...snapshot.request, randomSeed: item.randomSeed },
            snapshot.schedule,
            snapshot.universe,
            snapshot.provenancePin,
            snapshot.warnings,
            snapshot.benchmark,
            { cloneBatchId: batch.id, cloneSourceJobId: batch.sourceJobId },
          );
          this.database.db.update(backtestCloneBatchItems).set({
            state: 'DISPATCHED',
            jobId: job.id,
          }).where(eq(backtestCloneBatchItems.id, item.id)).run();
        }).immediate();
        available -= 1;
        if (available <= 0) break;
      }
    }
  }

  /** 상태 이벤트 뒤 새 슬롯을 채우고, 모든 item이 끝난 묶음을 완료 처리한다. */
  onJobStatusChanged(): void {
    this.pump();
    for (const batch of this.database.db
      .select()
      .from(backtestCloneBatches)
      .where(eq(backtestCloneBatches.status, 'ACTIVE'))
      .all()) {
      const detail = this.get(batch.id);
      if (!detail) continue;
      const allDispatched = detail.items.every(({ item }) => item.state === 'DISPATCHED');
      const allTerminal = detail.items.every(
        ({ item, job }) => item.state === 'DISPATCHED' && (job === null || this.queue.isTerminal(job.status)),
      );
      if (allDispatched && allTerminal) {
        this.database.db.update(backtestCloneBatches).set({
          status: 'COMPLETED',
          completedAtMs: this.clock.now(),
        }).where(eq(backtestCloneBatches.id, batch.id)).run();
      }
    }
  }

  recover(): void {
    this.pump();
    this.onJobStatusChanged();
  }

  /** 새 item 승격을 먼저 막는다. 호출자는 반환된 기존 job만 일반 취소 시퀀스로 보낸다. */
  cancel(batchId: string): SeedCloneBatchDetail | null {
    const existing = this.get(batchId);
    if (!existing || existing.batch.status !== 'ACTIVE') return existing;
    this.database.db.transaction((tx) => {
      tx.update(backtestCloneBatches).set({
        status: 'CANCELLED',
        completedAtMs: this.clock.now(),
      }).where(eq(backtestCloneBatches.id, batchId)).run();
      for (const { item } of existing.items) {
        if (item.state !== 'PENDING') continue;
        tx.update(backtestCloneBatchItems).set({ state: 'CANCELLED' })
          .where(eq(backtestCloneBatchItems.id, item.id)).run();
      }
    });
    return this.get(batchId);
  }

  get(batchId: string): SeedCloneBatchDetail | null {
    const batch = this.database.db
      .select()
      .from(backtestCloneBatches)
      .where(eq(backtestCloneBatches.id, batchId))
      .get();
    if (!batch) return null;
    const items = this.database.db
      .select()
      .from(backtestCloneBatchItems)
      .where(eq(backtestCloneBatchItems.batchId, batchId))
      .orderBy(asc(backtestCloneBatchItems.ordinal))
      .all()
      .map((item) => ({
        item,
        job: item.jobId === null ? null : this.queue.getJob(item.jobId),
      }));
    return { batch, items };
  }

  list(limit = 100): SeedCloneBatchDetail[] {
    return this.database.db
      .select()
      .from(backtestCloneBatches)
      .orderBy(desc(backtestCloneBatches.createdAtMs))
      .limit(limit)
      .all()
      .map((batch) => this.get(batch.id))
      .filter((detail): detail is SeedCloneBatchDetail => detail !== null);
  }
}

function uniqueSeeds(count: number, excluded: number): number[] {
  const values = new Set<number>();
  while (values.size < count) {
    const candidate = randomInt(0, MAX_RANDOM_SEED + 1);
    if (candidate !== excluded) values.add(candidate);
  }
  return [...values];
}

function parseSnapshot(batch: SeedCloneBatchRow): SeedCloneBatchSnapshot {
  const request = backtestRequestSchema.parse(JSON.parse(batch.requestJson));
  const schedule = JSON.parse(batch.universeScheduleJson) as LegacyUniverseScheduleEntry[];
  const universeEntries = batch.universeJson === null ? [] : JSON.parse(batch.universeJson);
  const provenancePin = JSON.parse(batch.provenancePinJson ?? 'null') as ProvenancePin | null;
  const benchmark = benchmarkPinSchema.parse(JSON.parse(batch.benchmarkJson ?? 'null'));
  const warnings = batch.submitWarningsJson === null
    ? []
    : JSON.parse(batch.submitWarningsJson) as string[];
  if (!Array.isArray(schedule) || schedule.length === 0) throw new Error('저장된 유니버스 일정이 없습니다.');
  if (!Array.isArray(universeEntries) || batch.universeHash === null) {
    throw new Error('저장된 유니버스 버전 pin이 없습니다.');
  }
  if (provenancePin === null || batch.benchmarkHash === null) {
    throw new Error('저장된 재현성 pin이 없습니다.');
  }
  return {
    request,
    schedule,
    universe: { entries: universeEntries, hash: batch.universeHash },
    provenancePin,
    benchmark: { pin: benchmark, hash: batch.benchmarkHash },
    warnings,
  };
}
