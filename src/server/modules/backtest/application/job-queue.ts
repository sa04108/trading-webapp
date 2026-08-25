import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDatabase, DatabaseHandle } from '../../../shared/db/database.js';
import { backtestJobs } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { BacktestRequest } from '../../../../shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../../../../shared/schemas/provenance-pin.js';
import type { LegacyUniverseScheduleEntry } from './universe-rule-resolver.js';
import type { BenchmarkPin } from '../../../../shared/schemas/benchmark.js';

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

export interface EnqueueMetadata {
  readonly cloneBatchId?: string | null;
  readonly cloneSourceJobId?: string | null;
}

export interface RemoteLeaseHeartbeat {
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseTokenHash: string;
  readonly nowMs: number;
  readonly nextLeaseExpiresAtMs: number;
  readonly processedBars: number | null;
  readonly totalBars: number | null;
  readonly progressLabel: string | null;
}

export interface ExpiredRemoteLease {
  readonly jobId: string;
  readonly status: 'QUEUED' | 'FAILED' | 'CANCELLED';
  readonly attempt: number;
}

export type CompleteRemoteResult =
  | 'ACCEPTED'
  | 'IDEMPOTENT'
  | 'IDENTITY_REJECTED'
  | 'STALE_LEASE';

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
    schedule: readonly LegacyUniverseScheduleEntry[] = [],
    /** 제출 시점 종목 버전 스냅샷 — 실행 시점의 latest 로 대체되지 않도록 고정한다 (§9.5) */
    pinnedUniverse?: { entries: readonly unknown[]; hash: string },
    /** 서버 소유 provenance pin (Task 12, REVIEW §9.2) — validateSubmission 이 조립한 값이다 */
    provenancePin?: ProvenancePin | null,
    /**
     * 제출 검증이 만든 경고 — 응답으로만 나가면 토스트와 함께 사라진다.
     * 기본값 `[]` 는 `schedule` 과 같은 이유다: 단위 테스트가 매번 채우지 않아도 된다.
     */
    submitWarnings: readonly string[] = [],
    benchmark?: { pin: BenchmarkPin; hash: string },
    metadata: EnqueueMetadata = {},
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
      benchmarkJson: benchmark ? JSON.stringify(benchmark.pin) : null,
      benchmarkHash: benchmark?.hash ?? null,
      cloneBatchId: metadata.cloneBatchId ?? null,
      cloneSourceJobId: metadata.cloneSourceJobId ?? null,
      submitWarningsJson: submitWarnings.length > 0 ? JSON.stringify(submitWarnings) : null,
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

  /** 원격 worker용 원자적 claim. attempt가 올라가므로 이전 lease의 늦은 응답은 무효다. */
  claimNextRemote(options: {
    readonly workerId: string;
    readonly leaseTokenHash: string;
    readonly leaseExpiresAtMs: number;
    readonly runnerVersion: string;
    readonly maxAttempts: number;
  }): BacktestJobRow | null {
    const stmt = this.handle.sqlite.prepare(
      `UPDATE backtest_jobs
       SET status = 'STARTING',
           started_at_ms = COALESCE(started_at_ms, ?),
           worker_id = ?,
           pid = NULL,
           attempt = attempt + 1,
           lease_token_hash = ?,
           lease_expires_at_ms = ?,
           runner_version = ?,
           error = NULL,
           progress_bars = NULL,
           total_bars = NULL,
           progress_label = NULL
       WHERE id = (
         SELECT id FROM backtest_jobs
         WHERE status = 'QUEUED' AND attempt < ?
         ORDER BY created_at_ms ASC
         LIMIT 1
       )
       RETURNING id`,
    );
    const claim = this.handle.sqlite.transaction(() => {
      const row = stmt.get(
        this.clock.now(),
        options.workerId,
        options.leaseTokenHash,
        options.leaseExpiresAtMs,
        options.runnerVersion,
        options.maxAttempts,
      ) as { id: string } | undefined;
      return row?.id ?? null;
    });
    const claimedId = claim.immediate();
    return claimedId ? this.getJob(claimedId) : null;
  }

  /** heartbeat와 lease 연장을 한 조건부 UPDATE로 처리해 만료 직후의 부활을 막는다. */
  heartbeatRemote(input: RemoteLeaseHeartbeat): BacktestJobStatus | null {
    const row = this.handle.sqlite.prepare(
      `UPDATE backtest_jobs
       SET status = CASE WHEN status = 'STARTING' THEN 'RUNNING' ELSE status END,
           lease_expires_at_ms = ?,
           progress_bars = COALESCE(?, progress_bars),
           total_bars = COALESCE(?, total_bars),
           progress_label = COALESCE(?, progress_label)
       WHERE id = ?
         AND attempt = ?
         AND lease_token_hash = ?
         AND lease_expires_at_ms >= ?
         AND status IN ('STARTING', 'RUNNING', 'CANCELLING')
       RETURNING status`,
    ).get(
      input.nextLeaseExpiresAtMs,
      input.processedBars,
      input.totalBars,
      input.progressLabel,
      input.jobId,
      input.attempt,
      input.leaseTokenHash,
      input.nowMs,
    ) as { status: BacktestJobStatus } | undefined;
    return row?.status ?? null;
  }

  finishRemote(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseTokenHash: string;
    readonly nowMs: number;
    readonly status: 'FAILED' | 'CANCELLED';
    readonly error?: string;
  }): 'FAILED' | 'CANCELLED' | null {
    const row = this.handle.sqlite.prepare(
      `UPDATE backtest_jobs
       SET status = CASE WHEN status = 'CANCELLING' THEN 'CANCELLED' ELSE ? END,
           error = CASE WHEN status = 'CANCELLING' THEN NULL ELSE ? END,
           completed_at_ms = ?,
           lease_token_hash = NULL, lease_expires_at_ms = NULL
       WHERE id = ?
         AND attempt = ?
         AND lease_token_hash = ?
         AND lease_expires_at_ms >= ?
         AND status IN ('STARTING', 'RUNNING', 'CANCELLING')
       RETURNING status`,
    ).get(
      input.status,
      input.error ?? null,
      input.nowMs,
      input.jobId,
      input.attempt,
      input.leaseTokenHash,
      input.nowMs,
    ) as { status: 'FAILED' | 'CANCELLED' } | undefined;
    return row?.status ?? null;
  }

  /** 결과 import와 COMPLETED 전이를 같은 SQLite transaction으로 묶는다. */
  completeRemote(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseTokenHash: string;
    readonly nowMs: number;
    readonly resultSchemaVersion: number;
    readonly resultChecksum: string;
    readonly processedBars: number;
    /** 같은 IMMEDIATE transaction에서 결과 import 직전 재검증한다. 오류 문자열이면 FAILED. */
    readonly validate: (current: BacktestJobRow) => string | null;
    readonly persist: () => void;
  }): CompleteRemoteResult {
    const complete = this.handle.sqlite.transaction((): CompleteRemoteResult => {
      const current = this.getJob(input.jobId);
      if (
        current?.status === 'COMPLETED'
        && current.attempt === input.attempt
        && current.resultSchemaVersion === input.resultSchemaVersion
        && current.resultChecksum === input.resultChecksum
      ) return 'IDEMPOTENT';
      if (
        current === null
        || (current.status !== 'STARTING' && current.status !== 'RUNNING')
        || current.attempt !== input.attempt
        || current.leaseTokenHash !== input.leaseTokenHash
        || current.leaseExpiresAtMs === null
        || current.leaseExpiresAtMs < input.nowMs
      ) return 'STALE_LEASE';

      const validationError = input.validate(current);
      if (validationError !== null) {
        const completedAtMs = this.clock.now();
        const rejected = this.handle.sqlite.prepare(
          `UPDATE backtest_jobs
           SET status = 'FAILED', error = ?, completed_at_ms = ?,
               lease_token_hash = NULL, lease_expires_at_ms = NULL
           WHERE id = ?
             AND attempt = ?
             AND lease_token_hash = ?
             AND status IN ('STARTING', 'RUNNING')`,
        ).run(
          validationError,
          completedAtMs,
          input.jobId,
          input.attempt,
          input.leaseTokenHash,
        );
        if (rejected.changes !== 1) {
          throw new Error('종목 identity 거부 후 job 실패 전이에 실패했습니다');
        }
        return 'IDENTITY_REJECTED';
      }

      input.persist();
      const completedAtMs = this.clock.now();
      const result = this.handle.sqlite.prepare(
        `UPDATE backtest_jobs
         SET status = 'COMPLETED',
             progress_bars = ?,
             total_bars = ?,
             error = NULL,
             completed_at_ms = ?,
             lease_token_hash = NULL,
             lease_expires_at_ms = NULL,
             result_schema_version = ?,
             result_checksum = ?
         WHERE id = ?
           AND attempt = ?
           AND lease_token_hash = ?
           AND status IN ('STARTING', 'RUNNING')`,
      ).run(
        input.processedBars,
        input.processedBars,
        completedAtMs,
        input.resultSchemaVersion,
        input.resultChecksum,
        input.jobId,
        input.attempt,
        input.leaseTokenHash,
      );
      if (result.changes !== 1) throw new Error('결과 import 후 job 완료 전이에 실패했습니다');
      return 'ACCEPTED';
    });
    return complete.immediate();
  }

  /** 만료 lease는 재시도하고, 취소 중이거나 attempt를 소진한 작업만 terminal로 보낸다. */
  recoverExpiredRemoteLeases(maxAttempts: number): ExpiredRemoteLease[] {
    const nowMs = this.clock.now();
    // 운영 중 maxAttempts를 낮추면 이미 그 횟수만큼 시도한 QUEUED 행은 claim 조건에서
    // 영원히 제외된다. attempt>0은 한 번이라도 remote claim됐다는 표식이다.
    const exhaustedQueued = this.handle.sqlite.prepare(
      `SELECT id, attempt
       FROM backtest_jobs
       WHERE status = 'QUEUED'
         AND attempt > 0
         AND attempt >= ?
       ORDER BY created_at_ms ASC`,
    ).all(maxAttempts) as Array<{ id: string; attempt: number }>;
    const expired = this.handle.sqlite.prepare(
      `SELECT id, status, attempt
       FROM backtest_jobs
       WHERE worker_id LIKE 'remote:%'
         AND status IN ('STARTING', 'RUNNING', 'CANCELLING')
         AND lease_expires_at_ms < ?
       ORDER BY created_at_ms ASC`,
    ).all(nowMs) as Array<{ id: string; status: BacktestJobStatus; attempt: number }>;
    if (expired.length === 0 && exhaustedQueued.length === 0) return [];

    const recover = this.handle.sqlite.transaction(() => {
      const recovered: ExpiredRemoteLease[] = [];
      for (const job of exhaustedQueued) {
        const result = this.handle.sqlite.prepare(
          `UPDATE backtest_jobs
           SET status = 'FAILED',
               error = ?,
               completed_at_ms = ?
           WHERE id = ?
             AND attempt = ?
             AND status = 'QUEUED'`,
        ).run(
          `원격 worker 최대 시도 횟수가 ${maxAttempts}회로 설정되어 재시도를 중단했습니다.`,
          nowMs,
          job.id,
          job.attempt,
        );
        if (result.changes > 0) {
          recovered.push({ jobId: job.id, status: 'FAILED', attempt: job.attempt });
        }
      }
      for (const job of expired) {
        const status: ExpiredRemoteLease['status'] = job.status === 'CANCELLING'
          ? 'CANCELLED'
          : job.attempt >= maxAttempts
            ? 'FAILED'
            : 'QUEUED';
        const result = this.handle.sqlite.prepare(
          `UPDATE backtest_jobs
           SET status = ?,
               worker_id = CASE WHEN ? = 'QUEUED' THEN NULL ELSE worker_id END,
               pid = NULL,
               lease_token_hash = NULL,
               lease_expires_at_ms = NULL,
               runner_version = CASE WHEN ? = 'QUEUED' THEN NULL ELSE runner_version END,
               error = ?,
               completed_at_ms = ?
           WHERE id = ?
             AND attempt = ?
             AND lease_expires_at_ms < ?
             AND status IN ('STARTING', 'RUNNING', 'CANCELLING')`,
        ).run(
          status,
          status,
          status,
          status === 'FAILED'
            ? `원격 worker lease가 ${job.attempt}회 만료되어 재시도를 중단했습니다.`
            : status === 'QUEUED'
              ? `원격 worker lease가 만료되어 ${job.attempt + 1}번째 시도를 대기합니다.`
              : null,
          status === 'QUEUED' ? null : nowMs,
          job.id,
          job.attempt,
          nowMs,
        );
        if (result.changes > 0) recovered.push({ jobId: job.id, status, attempt: job.attempt });
      }
      return recovered;
    });
    return recover.immediate();
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
   * 일반 백테스트 목록용 최상위 작업. 난수 시드 배치 자식은 부모 묶음 화면에서만
   * 노출해야 100개 자식이 페이지 한도를 차지해 기존 작업을 밀어내지 않는다.
   */
  listTopLevelJobs(limit = 50, offset = 0): BacktestJobRow[] {
    return this.db
      .select()
      .from(backtestJobs)
      .where(isNull(backtestJobs.cloneBatchId))
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
      .all()
      // 원격 job의 생존성은 OS pid가 아니라 lease로 판정한다. 서버 재시작 직후 pid=null을
      // 이유로 INTERRUPTED 처리하면 살아 있는 worker의 heartbeat/result가 모두 stale이 된다.
      .filter((job) => job.workerId?.startsWith('remote:') !== true);

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

  /** 로컬 실행 모드로 전환할 때 더는 갱신할 endpoint가 없는 원격 lease를 명시적으로 닫는다. */
  interruptActiveRemoteLeases(): string[] {
    const rows = this.handle.sqlite.prepare(
      `UPDATE backtest_jobs
       SET status = 'INTERRUPTED',
           error = '서버가 로컬 실행 모드로 전환되어 원격 worker lease를 종료했습니다.',
           completed_at_ms = ?,
           lease_token_hash = NULL,
           lease_expires_at_ms = NULL
       WHERE worker_id LIKE 'remote:%'
         AND status IN ('STARTING', 'RUNNING', 'CANCELLING')
       RETURNING id`,
    ).all(this.clock.now()) as Array<{ id: string }>;
    return rows.map((row) => row.id);
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
