import { count, desc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase, DatabaseHandle } from '../../../shared/db/database.js';
import { backtestJobs } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { BacktestRequest } from '../../../../shared/schemas/backtest-request.js';

export type BacktestJobStatus =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED';

export type BacktestJobRow = typeof backtestJobs.$inferSelect;

const ACTIVE_STATUSES: BacktestJobStatus[] = ['STARTING', 'RUNNING', 'CANCELLING'];
const TERMINAL_STATUSES: BacktestJobStatus[] = ['CANCELLED', 'COMPLETED', 'FAILED', 'INTERRUPTED'];

/** SQLite 지속성 작업 큐 (스펙 §10) */
export class JobQueue {
  private readonly db: AppDatabase;

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly clock: Clock,
  ) {
    this.db = handle.db;
  }

  enqueue(
    request: BacktestRequest,
    /** 제출 시점 데이터셋 스냅샷 — 실행 시점의 latest 로 대체되지 않도록 고정한다 */
    pinnedDataset?: { version: number; contentHash: string },
  ): BacktestJobRow {
    const row: typeof backtestJobs.$inferInsert = {
      id: newId('bt'),
      status: 'QUEUED',
      requestJson: JSON.stringify(request),
      strategyId: request.strategyId,
      datasetId: request.datasetId,
      datasetVersion: pinnedDataset?.version ?? null,
      datasetHash: pinnedDataset?.contentHash ?? null,
      createdAtMs: this.clock.now(),
    };
    this.db.insert(backtestJobs).values(row).run();
    return this.getJob(row.id) as BacktestJobRow;
  }

  /** 원자적 작업 확보 — BEGIN IMMEDIATE (스펙 §10) */
  claimNext(workerId: string): BacktestJobRow | null {
    const stmt = this.handle.sqlite.prepare(
      `UPDATE backtest_jobs
       SET status = 'STARTING', started_at_ms = ?, worker_id = ?
       WHERE id = (
         SELECT id FROM backtest_jobs
         WHERE status = 'QUEUED'
         ORDER BY created_at_ms ASC
         LIMIT 1
       )
       RETURNING id`,
    );
    const claim = this.handle.sqlite.transaction(() => {
      const row = stmt.get(this.clock.now(), workerId) as { id: string } | undefined;
      return row?.id ?? null;
    });
    const claimedId = claim.immediate();
    return claimedId ? this.getJob(claimedId) : null;
  }

  getJob(jobId: string): BacktestJobRow | null {
    return this.db.select().from(backtestJobs).where(eq(backtestJobs.id, jobId)).get() ?? null;
  }

  listJobs(limit = 50, offset = 0): BacktestJobRow[] {
    return this.db
      .select()
      .from(backtestJobs)
      .orderBy(desc(backtestJobs.createdAtMs))
      .limit(limit)
      .offset(offset)
      .all();
  }

  setStatus(jobId: string, status: BacktestJobStatus, patch: Partial<BacktestJobRow> = {}): void {
    const terminal = TERMINAL_STATUSES.includes(status);
    this.db
      .update(backtestJobs)
      .set({
        status,
        ...(terminal ? { completedAtMs: this.clock.now() } : {}),
        ...patch,
      })
      .where(eq(backtestJobs.id, jobId))
      .run();
  }

  updateProgress(
    jobId: string,
    progressBars: number,
    totalBars: number,
    currentSymbol: string | null,
  ): void {
    this.db
      .update(backtestJobs)
      .set({ progressBars, totalBars, currentSymbol, status: 'RUNNING' })
      .where(eq(backtestJobs.id, jobId))
      .run();
  }

  /** 재시작 복구 (스펙 §10): 살아있는 프로세스가 없는 활성 작업을 INTERRUPTED 로 */
  recoverInterrupted(isPidAlive: (pid: number) => boolean): string[] {
    const active = this.db
      .select()
      .from(backtestJobs)
      .where(inArray(backtestJobs.status, ACTIVE_STATUSES))
      .all();

    const recovered: string[] = [];
    for (const job of active) {
      const alive = job.pid !== null && isPidAlive(job.pid);
      if (!alive) {
        this.setStatus(job.id, 'INTERRUPTED', {
          error: '서버 재시작으로 작업이 중단되었습니다. 복제 후 재실행하세요.',
        });
        recovered.push(job.id);
      }
    }
    return recovered;
  }

  deleteJob(jobId: string): boolean {
    const job = this.getJob(jobId);
    if (!job || !TERMINAL_STATUSES.includes(job.status as BacktestJobStatus)) return false;
    this.db.delete(backtestJobs).where(eq(backtestJobs.id, jobId)).run();
    return true;
  }

  countByStatus(statuses: BacktestJobStatus[]): number {
    const row = this.db
      .select({ value: count() })
      .from(backtestJobs)
      .where(inArray(backtestJobs.status, statuses))
      .get();
    return row?.value ?? 0;
  }

  isTerminal(status: string): boolean {
    return TERMINAL_STATUSES.includes(status as BacktestJobStatus);
  }
}
