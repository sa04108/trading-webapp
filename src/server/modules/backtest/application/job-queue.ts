import { EventEmitter } from "node:events";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type {
  AppDatabase,
  DatabaseHandle,
} from "../../../../runtime/shared/db/database.js";
import { PreparationPreviewCache } from "../../../../runtime/modules/backtest/application/preparation-preview-cache.js";
import {
  PreparationReferenceError,
  PreparationReferenceService,
} from "./preparation-reference-service.js";
import { backtestJobs } from "../../../../runtime/shared/db/operations-schema.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import { newId } from "../../../../runtime/shared/ids.js";
import type { BacktestRequest } from "../../../../shared/schemas/backtest-request.js";
import type { ProvenancePin } from "../../../../shared/schemas/provenance-pin.js";
import type { LegacyUniverseScheduleEntry } from "../../../../runtime/modules/backtest/application/universe-rule-resolver.js";
import type { BenchmarkPin } from "../../../../shared/schemas/benchmark.js";
import type { ExecutionActivity } from "../../../../shared/execution-progress.js";

export type BacktestJobStatus =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
  | "CANCELLING"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED";

export type BacktestJobRow = typeof backtestJobs.$inferSelect;

export interface EnqueueMetadata {
  readonly estimatedBars?: number;
  readonly preparationJobId?: string | null;
  readonly wizardOwner?: {
    readonly userId: string;
    readonly context?: string;
    readonly requireMatch?: boolean;
  };
  readonly cloneBatchId?: string | null;
  readonly cloneSourceJobId?: string | null;
}

export interface LeaseHeartbeat {
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseTokenHash: string;
  readonly nowMs: number;
  readonly nextLeaseExpiresAtMs: number;
  readonly processedBars: number | null;
  readonly totalBars: number | null;
  readonly progressLabel: string | null;
  readonly activity?: ExecutionActivity | null;
}

export interface LeaseActivityUpdate {
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseTokenHash: string;
  readonly nowMs: number;
  readonly activity: ExecutionActivity;
  readonly completed?: number | null;
  readonly total?: number | null;
}

export interface ExpiredLease {
  readonly jobId: string;
  readonly status: "QUEUED" | "CANCELLED" | "FAILED";
  readonly attempt: number;
}

export type CompleteLeasedResult =
  "ACCEPTED" | "IDEMPOTENT" | "IDENTITY_REJECTED" | "STALE_LEASE";

const ACTIVE_STATUSES: BacktestJobStatus[] = [
  "STARTING",
  "RUNNING",
  "CANCELLING",
];
export const TERMINAL_STATUSES: BacktestJobStatus[] = [
  "CANCELLED",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
];

/** SQLite 지속성 작업 큐 (스펙 §10) */
export class JobQueue {
  readonly events = new EventEmitter();
  private readonly db: AppDatabase;

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly clock: Clock,
    private readonly providerFreshness?: () => { lastCheckedAtMs: number | null; checkedThrough: string | null; warning: string | null },
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
    const job = this.handle.sqlite
      .transaction(() => {
        const references = new PreparationReferenceService(this.handle);
        const preparationJobId =
          metadata.preparationJobId ??
          (metadata.cloneSourceJobId
            ? this.getJob(metadata.cloneSourceJobId)?.preparationJobId
            : null) ??
          null;
        if (preparationJobId)
          references.requirePreparation(preparationJobId, true);
        const owner = metadata.wizardOwner
          ? references.getWizard(
              metadata.wizardOwner.userId,
              metadata.wizardOwner.context,
            )
          : null;
        if (
          metadata.wizardOwner?.requireMatch &&
          (!preparationJobId ||
            owner?.preparationJobId !== preparationJobId ||
            !new PreparationPreviewCache(this.handle).isFresh(preparationJobId))
        ) {
          throw new PreparationReferenceError();
        }
        const freshness = this.providerFreshness?.();
        const warnings = [...submitWarnings, ...(freshness?.warning ? [freshness.warning] : [])];
        const row: typeof backtestJobs.$inferInsert = {
          id: newId("bt"),
          preparationJobId,
          status: "QUEUED",
          estimatedBars:
            metadata.estimatedBars ??
            (metadata.cloneSourceJobId
              ? this.getJob(metadata.cloneSourceJobId)?.estimatedBars
              : 0) ??
            0,
          requestJson: JSON.stringify(request),
          strategyId: request.strategyId,
          universeRuleJson: JSON.stringify(request.universeRule),
          universeScheduleJson: JSON.stringify(schedule),
          provenancePinJson: provenancePin
            ? JSON.stringify(provenancePin)
            : null,
          universeJson: pinnedUniverse
            ? JSON.stringify(pinnedUniverse.entries)
            : null,
          universeHash: pinnedUniverse?.hash ?? null,
          benchmarkJson: benchmark ? JSON.stringify(benchmark.pin) : null,
          benchmarkHash: benchmark?.hash ?? null,
          cloneBatchId: metadata.cloneBatchId ?? null,
          cloneSourceJobId: metadata.cloneSourceJobId ?? null,
          submitWarningsJson:
            warnings.length > 0 ? JSON.stringify(warnings) : null,
          createdAtMs: this.clock.now(),
        };
        this.db.insert(backtestJobs).values(row).run();
        if (freshness) this.handle.sqlite.prepare(`INSERT INTO provider_execution_provenance
          (job_id, freshness_json) VALUES (?, ?)`).run(row.id, JSON.stringify(freshness));
        if (metadata.wizardOwner && preparationJobId) {
          const context = metadata.wizardOwner.context ?? owner?.context;
          if (context !== undefined) {
            // 복제 화면을 빠르게 제출해 참조 자동 저장이 아직 없더라도 해당 초안은 정리한다.
            references.finishWizard(
              metadata.wizardOwner.userId,
              context,
              preparationJobId,
            );
          }
        }
        references.collect();
        return this.getJob(row.id) as BacktestJobRow;
      })
      .immediate();
    this.events.emit("queued", job.id);
    return job;
  }

  /** 에이전트에 작업을 임대하는 원자적 claim. attempt가 올라가므로 이전 lease의 늦은 응답은 무효다. */
  claimNextLease(options: {
    readonly agentId: string;
    readonly leaseTokenHash: string;
    readonly leaseExpiresAtMs: number;
    readonly runnerVersion: string;
    readonly maxAttempts: number;
    readonly maxBars?: number;
  }): BacktestJobRow | null {
    const stmt = this.handle.sqlite.prepare(
      `UPDATE backtest_jobs
       SET status = 'STARTING',
           started_at_ms = COALESCE(started_at_ms, ?),
           agent_id = ?,
           pid = NULL,
           attempt = attempt + 1,
           lease_token_hash = ?,
           lease_expires_at_ms = ?,
           runner_version = ?,
           error = NULL,
           progress_bars = NULL,
           total_bars = NULL,
           progress_label = NULL,
           execution_activity = 'LOADING_BACKTEST_INPUT',
           activity_started_at_ms = ?,
           last_progress_at_ms = NULL,
           last_received_at_ms = NULL,
           result_transfer_bytes = NULL,
           result_transfer_total_bytes = NULL
       WHERE id = (
         SELECT id FROM backtest_jobs
         WHERE status = 'QUEUED' AND lease_failures < ? AND estimated_bars <= ?
         ORDER BY created_at_ms ASC
         LIMIT 1
       )
       RETURNING id`,
    );
    const claim = this.handle.sqlite.transaction(() => {
      const row = stmt.get(
        this.clock.now(),
        options.agentId,
        options.leaseTokenHash,
        options.leaseExpiresAtMs,
        options.runnerVersion,
        this.clock.now(),
        options.maxAttempts,
        options.maxBars ?? Number.MAX_SAFE_INTEGER,
      ) as { id: string } | undefined;
      return row?.id ?? null;
    });
    const claimedId = claim.immediate();
    return claimedId ? this.getJob(claimedId) : null;
  }

  /** heartbeat와 lease 연장을 한 조건부 UPDATE로 처리해 만료 직후의 부활을 막는다. */
  heartbeatLease(input: LeaseHeartbeat): BacktestJobStatus | null {
    const row = this.handle.sqlite
      .prepare(
        `UPDATE backtest_jobs
       SET status = CASE WHEN status = 'STARTING' THEN 'RUNNING' ELSE status END,
           lease_expires_at_ms = ?,
           progress_bars = COALESCE(?, progress_bars),
           total_bars = COALESCE(?, total_bars),
           progress_label = COALESCE(?, progress_label),
           activity_started_at_ms = CASE WHEN ? IS NOT NULL AND ? IS NOT execution_activity THEN ? ELSE activity_started_at_ms END,
           execution_activity = COALESCE(?, execution_activity),
           last_progress_at_ms = CASE
             WHEN (? IS NOT NULL AND ? IS NOT progress_bars)
               OR (? IS NOT NULL AND ? IS NOT total_bars)
               OR (? IS NOT NULL AND ? IS NOT progress_label)
               OR (? IS NOT NULL AND ? IS NOT execution_activity)
             THEN ? ELSE last_progress_at_ms END,
           last_received_at_ms = ?
       WHERE id = ?
         AND attempt = ?
         AND lease_token_hash = ?
         AND lease_expires_at_ms >= ?
         AND status IN ('STARTING', 'RUNNING', 'CANCELLING')
       RETURNING status`,
      )
      .get(
        input.nextLeaseExpiresAtMs,
        input.processedBars,
        input.totalBars,
        input.progressLabel,
        input.activity ?? null,
        input.activity ?? null,
        input.nowMs,
        input.activity ?? null,
        input.processedBars,
        input.processedBars,
        input.totalBars,
        input.totalBars,
        input.progressLabel,
        input.progressLabel,
        input.activity ?? null,
        input.activity ?? null,
        input.nowMs,
        input.nowMs,
        input.jobId,
        input.attempt,
        input.leaseTokenHash,
        input.nowMs,
      ) as { status: BacktestJobStatus } | undefined;
    return row?.status ?? null;
  }

  updateLeaseActivity(input: LeaseActivityUpdate): boolean {
    return (
      this.handle.sqlite
        .prepare(
          `UPDATE backtest_jobs SET
             activity_started_at_ms = CASE WHEN execution_activity IS NOT ? THEN ? ELSE activity_started_at_ms END,
             execution_activity = ?,
             result_transfer_bytes = COALESCE(?, result_transfer_bytes),
             result_transfer_total_bytes = COALESCE(?, result_transfer_total_bytes),
             last_progress_at_ms = ?, last_received_at_ms = ?
           WHERE id = ? AND attempt = ? AND lease_token_hash = ?
             AND status IN ('STARTING', 'RUNNING', 'CANCELLING')`,
        )
        .run(
          input.activity,
          input.nowMs,
          input.activity,
          input.completed ?? null,
          input.total ?? null,
          input.nowMs,
          input.nowMs,
          input.jobId,
          input.attempt,
          input.leaseTokenHash,
        ).changes > 0
    );
  }

  finishLease(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseTokenHash: string;
    readonly nowMs: number;
    readonly status: "FAILED" | "CANCELLED";
    readonly error?: string;
  }): "FAILED" | "CANCELLED" | null {
    const row = this.handle.sqlite
      .prepare(
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
      )
      .get(
        input.status,
        input.error ?? null,
        input.nowMs,
        input.jobId,
        input.attempt,
        input.leaseTokenHash,
        input.nowMs,
      ) as { status: "FAILED" | "CANCELLED" } | undefined;
    return row?.status ?? null;
  }

  /** 결과 import와 COMPLETED 전이를 같은 SQLite transaction으로 묶는다. */
  completeLeasedResult(input: {
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
  }): CompleteLeasedResult {
    const complete = this.handle.sqlite.transaction(
      (): CompleteLeasedResult => {
        const current = this.getJob(input.jobId);
        if (
          current?.status === "COMPLETED" &&
          current.attempt === input.attempt &&
          current.resultSchemaVersion === input.resultSchemaVersion &&
          current.resultChecksum === input.resultChecksum
        )
          return "IDEMPOTENT";
        if (
          current === null ||
          (current.status !== "STARTING" && current.status !== "RUNNING") ||
          current.attempt !== input.attempt ||
          current.leaseTokenHash !== input.leaseTokenHash ||
          current.leaseExpiresAtMs === null ||
          current.leaseExpiresAtMs < input.nowMs
        )
          return "STALE_LEASE";

        const validationError = input.validate(current);
        if (validationError !== null) {
          const completedAtMs = this.clock.now();
          const rejected = this.handle.sqlite
            .prepare(
              `UPDATE backtest_jobs
           SET status = 'FAILED', error = ?, completed_at_ms = ?,
               lease_token_hash = NULL, lease_expires_at_ms = NULL
           WHERE id = ?
             AND attempt = ?
             AND lease_token_hash = ?
             AND status IN ('STARTING', 'RUNNING')`,
            )
            .run(
              validationError,
              completedAtMs,
              input.jobId,
              input.attempt,
              input.leaseTokenHash,
            );
          if (rejected.changes !== 1) {
            throw new Error(
              "종목 identity 거부 후 job 실패 전이에 실패했습니다",
            );
          }
          return "IDENTITY_REJECTED";
        }

        input.persist();
        const completedAtMs = this.clock.now();
        const result = this.handle.sqlite
          .prepare(
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
          )
          .run(
            input.processedBars,
            input.processedBars,
            completedAtMs,
            input.resultSchemaVersion,
            input.resultChecksum,
            input.jobId,
            input.attempt,
            input.leaseTokenHash,
          );
        if (result.changes !== 1)
          throw new Error("결과 import 후 job 완료 전이에 실패했습니다");
        return "ACCEPTED";
      },
    );
    return complete.immediate();
  }

  /** 만료된 계산 리스만 실패로 세고 재배정한다. 클라이언트 업데이트는 실패가 아니다. */
  recoverExpiredLeases(maxAttempts: number): ExpiredLease[] {
    const nowMs = this.clock.now();
    const expired = this.handle.sqlite
      .prepare(
        `SELECT id, status, attempt, lease_failures
       FROM backtest_jobs
       WHERE agent_id IS NOT NULL
         AND status IN ('STARTING', 'RUNNING', 'CANCELLING')
         AND lease_expires_at_ms < ?
       ORDER BY created_at_ms ASC`,
      )
      .all(nowMs) as Array<{
      id: string;
      status: BacktestJobStatus;
      attempt: number;
      lease_failures: number;
    }>;
    if (expired.length === 0) return [];

    const recover = this.handle.sqlite.transaction(() => {
      const recovered: ExpiredLease[] = [];
      for (const job of expired) {
        const status: ExpiredLease["status"] =
          job.status === "CANCELLING"
            ? "CANCELLED"
            : job.lease_failures + 1 >= maxAttempts
              ? "FAILED"
              : "QUEUED";
        const result = this.handle.sqlite
          .prepare(
            `UPDATE backtest_jobs
           SET status = ?, lease_failures = lease_failures + 1,
               agent_id = CASE WHEN ? = 'QUEUED' THEN NULL ELSE agent_id END,
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
          )
          .run(
            status,
            status,
            status,
            status === "FAILED"
              ? "에이전트 재시도 한도에 도달했습니다."
              : status === "QUEUED"
                ? `에이전트 lease가 만료되어 ${job.attempt + 1}번째 시도를 대기합니다.`
                : null,
            status === "QUEUED" ? null : nowMs,
            job.id,
            job.attempt,
            nowMs,
          );
        if (result.changes > 0)
          recovered.push({ jobId: job.id, status, attempt: job.attempt });
      }
      return recovered;
    });
    return recover.immediate();
  }

  getJob(jobId: string): BacktestJobRow | null {
    return (
      this.db
        .select()
        .from(backtestJobs)
        .where(eq(backtestJobs.id, jobId))
        .get() ?? null
    );
  }

  /**
   * 일반 백테스트 목록용 최상위 작업. 난수 시드 배치 자식은 부모 묶음 화면에서만
   * 노출해야 100개 자식이 페이지 한도를 차지해 기존 작업을 밀어내지 않는다.
   */
  listTopLevelJobs(limit = 50, offset = 0): BacktestJobRow[] {
    return this.db
      .select()
      .from(backtestJobs)
      .where(
        and(
          isNull(backtestJobs.cloneBatchId),
          sql`NOT EXISTS (
        SELECT 1 FROM backtest_validation_trials v WHERE v.job_id = ${backtestJobs.id}
      )`,
        ),
      )
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
      ? and(
          eq(backtestJobs.id, jobId),
          inArray(backtestJobs.status, expectedCurrent),
        )
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

  /** 에이전트 임대가 없는 과거 활성 작업을 서버 재시작 시 중단 처리한다. */
  recoverUnleasedJobs(): string[] {
    const active = this.db
      .select({ id: backtestJobs.id })
      .from(backtestJobs)
      .where(
        and(
          inArray(backtestJobs.status, ACTIVE_STATUSES),
          isNull(backtestJobs.agentId),
        ),
      )
      .all();
    const recovered: string[] = [];
    for (const job of active) {
      // 임대가 있는 작업은 에이전트의 heartbeat와 만료 시각으로 복구한다.
      const written = this.setStatus(
        job.id,
        "INTERRUPTED",
        {
          error: "서버 재시작으로 작업이 중단되었습니다. 복제 후 재실행하세요.",
        },
        ACTIVE_STATUSES,
      );
      if (written) recovered.push(job.id);
    }
    return recovered;
  }

  deleteJob(jobId: string): boolean {
    return this.handle.sqlite
      .transaction(() => {
        const job = this.getJob(jobId);
        if (
          !job ||
          !TERMINAL_STATUSES.includes(job.status as BacktestJobStatus)
        )
          return false;
        this.db.delete(backtestJobs).where(eq(backtestJobs.id, jobId)).run();
        new PreparationReferenceService(this.handle).collect();
        return true;
      })
      .immediate();
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
