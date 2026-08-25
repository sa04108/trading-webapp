import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
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
  backtestJobs,
  backtestCloneBatchItems,
  backtestCloneBatches,
} from '../../../shared/db/schema.js';
import { newId } from '../../../shared/ids.js';
import type { ConsumedVersionSnapshot } from '../../market-data/application/symbol-service.js';
import type { LegacyUniverseScheduleEntry } from './universe-rule-resolver.js';
import type { JobEvent } from './job-orchestrator.js';
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

export type SeedCloneBatchTerminalStatus = 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type SeedCloneDeleteResult = 'DELETED' | 'NOT_FOUND' | 'NOT_DELETABLE';

interface SeedCloneDeletionPlan {
  readonly batchIds: readonly string[];
  readonly jobIds: readonly string[];
}

export interface SeedCloneBatchEvent {
  readonly batchId: string;
  readonly status: SeedCloneBatchTerminalStatus;
}

export type SeedCloneSnapshotValidator = (
  schedule: readonly LegacyUniverseScheduleEntry[],
  request: BacktestRequest,
) => void;

/** 진행률 이벤트는 큐 슬롯이나 종료 여부를 바꾸지 않으므로 배치 DB를 다시 읽지 않는다. */
export function createSeedCloneBatchJobListener(
  service: Pick<SeedCloneBatchService, 'onJobStatusChanged'>,
): (event: JobEvent) => void {
  return (event) => {
    if (event.kind === 'status') service.onJobStatusChanged();
  };
}

/**
 * 1~100개 난수 시드 복제를 기존 QUEUED 상한 안에서 순차 승격하는 영속 서비스.
 * PENDING item은 가벼운 SQLite 행이라 100개를 미리 저장해도 워커 큐와 리소스 가드를
 * 우회하지 않는다. 실제 backtest_jobs는 빈 QUEUED 슬롯 수만큼만 생성한다.
 */
export class SeedCloneBatchService {
  readonly events = new EventEmitter();

  constructor(
    private readonly database: DatabaseHandle,
    private readonly queue: JobQueue,
    private readonly maxQueuedBacktests: number,
    private readonly clock: Clock,
    private readonly validateSnapshot: SeedCloneSnapshotValidator,
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
      const pending = this.database.db
        .select()
        .from(backtestCloneBatchItems)
        .where(and(
          eq(backtestCloneBatchItems.batchId, batch.id),
          eq(backtestCloneBatchItems.state, 'PENDING'),
        ))
        .orderBy(asc(backtestCloneBatchItems.ordinal))
        .limit(available)
        .all();
      // 모든 item이 이미 승격됐다면 자식 상태 이벤트마다 긴 schedule을 다시 검사할
      // 이유가 없다. 이미 만들어진 자식의 drift는 child 최종 guard가 맡는다.
      if (pending.length === 0) continue;

      let snapshot: SeedCloneBatchSnapshot;
      try {
        snapshot = parseSnapshot(batch);
        // create 시점과 실제 PENDING item 승격 사이에 SCD/등록 identity나 기간
        // coverage가 바뀔 수 있다. 매 pump의 enqueue 직전에 다시 검사해 이후 자식
        // 생성을 멈춘다.
        this.validateSnapshot(snapshot.schedule, snapshot.request);
      } catch (error) {
        this.markTerminal(
          batch.id,
          'FAILED',
          ['ACTIVE'],
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }

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
      .where(inArray(backtestCloneBatches.status, ['ACTIVE', 'CANCELLING']))
      .all()) {
      const detail = this.get(batch.id);
      if (!detail) continue;
      if (batch.status === 'ACTIVE') {
        const allTerminal = detail.items.every(
          ({ item, job }) =>
            item.state === 'DISPATCHED' &&
            (job === null || this.queue.isTerminal(job.status)),
        );
        if (allTerminal) this.markTerminal(batch.id, 'COMPLETED', ['ACTIVE']);
        continue;
      }

      const allCancelledOrTerminal = detail.items.every(
        ({ item, job }) =>
          item.state === 'CANCELLED' ||
          (item.state === 'DISPATCHED' &&
            (job === null || this.queue.isTerminal(job.status))),
      );
      if (allCancelledOrTerminal) this.markTerminal(batch.id, 'CANCELLED', ['CANCELLING']);
    }
  }

  recover(): void {
    this.onJobStatusChanged();
  }

  /** 새 item 승격을 먼저 막고, 실행 중 자식이 모두 끝날 때까지 CANCELLING을 유지한다. */
  cancel(batchId: string): SeedCloneBatchDetail | null {
    const existing = this.get(batchId);
    if (!existing || existing.batch.status !== 'ACTIVE') return existing;
    this.database.db.transaction((tx) => {
      tx.update(backtestCloneBatches).set({
        status: 'CANCELLING',
        completedAtMs: null,
      }).where(eq(backtestCloneBatches.id, batchId)).run();
      for (const { item } of existing.items) {
        if (item.state !== 'PENDING') continue;
        tx.update(backtestCloneBatchItems).set({ state: 'CANCELLED' })
          .where(eq(backtestCloneBatchItems.id, item.id)).run();
      }
    });
    // 실제 job이 하나도 없고 전부 묶음 대기였다면 이 자리에서 곧바로 최종 취소된다.
    this.onJobStatusChanged();
    return this.get(batchId);
  }

  /**
   * 종료된 난수 실험과 그 자식 job·결과를 한 트랜잭션에서 지운다.
   * 실행 중인 자식을 DB에서 먼저 지우면 워커가 고아 결과를 쓰게 되므로 거부한다.
   */
  delete(batchId: string): SeedCloneDeleteResult {
    return this.database.sqlite.transaction(() => {
      const detail = this.get(batchId);
      if (!detail) return 'NOT_FOUND';
      const plan = this.collectDeletionPlan([batchId]);
      if (!plan) return 'NOT_DELETABLE';
      this.executeDeletionPlan(plan);
      return 'DELETED';
    }).immediate();
  }

  /** 원본 백테스트와 그 원본에서 만든 모든 난수 실험·자식 결과를 원자적으로 지운다. */
  deleteSourceJob(sourceJobId: string): SeedCloneDeleteResult {
    return this.database.sqlite.transaction(() => {
      const source = this.queue.getJob(sourceJobId);
      if (!source) return 'NOT_FOUND';
      if (!this.queue.isTerminal(source.status)) return 'NOT_DELETABLE';

      const batches = this.database.db
        .select({ id: backtestCloneBatches.id })
        .from(backtestCloneBatches)
        .where(eq(backtestCloneBatches.sourceJobId, sourceJobId))
        .all();
      const plan = this.collectDeletionPlan(batches.map((batch) => batch.id));
      if (!plan) return 'NOT_DELETABLE';
      this.executeDeletionPlan(plan);
      this.database.db.delete(backtestJobs).where(eq(backtestJobs.id, sourceJobId)).run();
      return 'DELETED';
    }).immediate();
  }

  private isDeletable(detail: SeedCloneBatchDetail): boolean {
    const terminalBatch = detail.batch.status === 'COMPLETED'
      || detail.batch.status === 'FAILED'
      || detail.batch.status === 'CANCELLED';
    return terminalBatch && detail.items.every(
      ({ job }) => job === null || this.queue.isTerminal(job.status),
    );
  }

  /**
   * 옛 데이터에는 seed 자식 job을 다시 원본으로 삼은 중첩 묶음이 있을 수 있다.
   * 삭제 전에 전체 후손을 따라가 하나라도 실행 중이면 아무 행도 지우지 않는다.
   */
  private collectDeletionPlan(rootBatchIds: readonly string[]): SeedCloneDeletionPlan | null {
    const pending = [...rootBatchIds];
    const batchIds = new Set<string>();
    const jobIds = new Set<string>();
    while (pending.length > 0) {
      const batchId = pending.shift()!;
      if (batchIds.has(batchId)) continue;
      const detail = this.get(batchId);
      if (!detail || !this.isDeletable(detail)) return null;
      batchIds.add(batchId);

      for (const { job } of detail.items) {
        if (!job) continue;
        jobIds.add(job.id);
        const descendants = this.database.db
          .select({ id: backtestCloneBatches.id })
          .from(backtestCloneBatches)
          .where(eq(backtestCloneBatches.sourceJobId, job.id))
          .all();
        for (const descendant of descendants) pending.push(descendant.id);
      }
    }

    return { batchIds: [...batchIds], jobIds: [...jobIds] };
  }

  private executeDeletionPlan(plan: SeedCloneDeletionPlan): void {
    if (plan.jobIds.length > 0) {
      this.database.db.delete(backtestJobs).where(inArray(backtestJobs.id, [...plan.jobIds])).run();
    }
    if (plan.batchIds.length === 0) return;
    this.database.db
      .delete(backtestCloneBatches)
      .where(inArray(backtestCloneBatches.id, [...plan.batchIds]))
      .run();
  }

  private markTerminal(
    batchId: string,
    status: SeedCloneBatchTerminalStatus,
    expectedStatuses: readonly string[],
    error?: string,
  ): void {
    const result = this.database.db.update(backtestCloneBatches).set({
      status,
      completedAtMs: this.clock.now(),
      ...(error === undefined ? {} : { error }),
    }).where(and(
      eq(backtestCloneBatches.id, batchId),
      inArray(backtestCloneBatches.status, [...expectedStatuses]),
    )).run();
    if (result.changes > 0) {
      this.events.emit('batch', { batchId, status } satisfies SeedCloneBatchEvent);
    }
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
