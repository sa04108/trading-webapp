import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase, DatabaseHandle } from '../../../shared/db/database.js';
import { backtestJobs } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { BacktestRequest } from '../../../../shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../../../../shared/schemas/provenance-pin.js';
import type { UniverseScheduleEntry } from './universe-rule-resolver.js';

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
export const TERMINAL_STATUSES: BacktestJobStatus[] = [
  'CANCELLED',
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
];

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
    /**
     * `UniverseRuleResolver.resolve` 가 확정한 멤버십 일정 — 워커·엔진의 유일한
     * 유니버스 소스가 된다 (스펙 2026-08-05). 기본값 `[]` 는 JobQueue 자체를 단위
     * 테스트할 때(HTTP 제출 경로를 거치지 않을 때) 매번 채우지 않아도 되게 한다.
     */
    schedule: readonly UniverseScheduleEntry[] = [],
    /** 제출 시점 종목 버전 스냅샷 — 실행 시점의 latest 로 대체되지 않도록 고정한다 (§9.5) */
    pinnedUniverse?: { entries: readonly unknown[]; hash: string },
    /** 서버 소유 provenance pin (Task 12, REVIEW §9.2) — validateSubmission 이 조립한 값이다 */
    provenancePin?: ProvenancePin | null,
  ): BacktestJobRow {
    const row: typeof backtestJobs.$inferInsert = {
      id: newId('bt'),
      status: 'QUEUED',
      requestJson: JSON.stringify(request),
      strategyId: request.strategyId,
      universeRuleJson: JSON.stringify(request.universeRule),
      universeScheduleJson: JSON.stringify(schedule),
      provenancePinJson: provenancePin ? JSON.stringify(provenancePin) : null,
      universeJson: pinnedUniverse ? JSON.stringify(pinnedUniverse.entries) : null,
      universeHash: pinnedUniverse?.hash ?? null,
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

  /**
   * 상태 변경. expectedCurrent 를 주면 현재 상태가 그중 하나일 때만 쓴다 —
   * 프로세스 간 경합에서 종료 상태가 뒤늦은 쓰기로 되돌아가는 것을 막는다.
   */
  setStatus(
    jobId: string,
    status: BacktestJobStatus,
    patch: Partial<BacktestJobRow> = {},
    expectedCurrent?: BacktestJobStatus[],
  ): boolean {
    const terminal = TERMINAL_STATUSES.includes(status);
    const where = expectedCurrent
      ? and(eq(backtestJobs.id, jobId), inArray(backtestJobs.status, expectedCurrent))
      : eq(backtestJobs.id, jobId);
    const result = this.db
      .update(backtestJobs)
      .set({
        status,
        ...(terminal ? { completedAtMs: this.clock.now() } : {}),
        ...patch,
      })
      .where(where)
      .run();
    return result.changes > 0;
  }

  /** 첫 진행률 수신 시 1회 전이 — STARTING 이 아닐 때는 아무것도 하지 않는다 */
  markRunning(jobId: string): void {
    this.setStatus(jobId, 'RUNNING', {}, ['STARTING']);
  }

  /** 진행률만 갱신한다. 상태는 건드리지 않으며, 활성 상태가 아니면 무시된다. */
  updateProgress(
    jobId: string,
    progressBars: number,
    totalBars: number,
    progressLabel: string | null,
  ): void {
    this.db
      .update(backtestJobs)
      .set({ progressBars, totalBars, progressLabel })
      .where(and(eq(backtestJobs.id, jobId), inArray(backtestJobs.status, ACTIVE_STATUSES)))
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
        // 죽은 자식이 종료 직전에 남긴 쓰기와 경합하지 않도록 여기서도 활성 상태일 때만 쓴다
        const written = this.setStatus(
          job.id,
          'INTERRUPTED',
          { error: '서버 재시작으로 작업이 중단되었습니다. 복제 후 재실행하세요.' },
          ACTIVE_STATUSES,
        );
        if (written) recovered.push(job.id);
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
