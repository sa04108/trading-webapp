import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AppConfig } from '../../../bootstrap/config.js';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import type { BacktestExecutionTelemetry } from './backtest-execution-telemetry.js';
import type { BacktestJobRow, JobQueue } from './job-queue.js';
import type { JobEvent } from './job-orchestrator.js';
import type { RemoteResultCompleter } from './backtest-result-artifact.js';

export interface RemoteJobLease {
  readonly job: BacktestJobRow;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
  readonly runnerVersion: string;
}

export type RemoteClaimResult =
  | { readonly status: 'CLAIMED'; readonly lease: RemoteJobLease }
  | { readonly status: 'EMPTY' }
  | { readonly status: 'VERSION_MISMATCH'; readonly expectedRunnerVersion: string };

export type RemoteHeartbeatResult =
  | { readonly status: 'ACCEPTED'; readonly cancelRequested: boolean; readonly leaseExpiresAtMs: number }
  | { readonly status: 'STALE_LEASE' };
export type RemoteResultTransferResult = RemoteHeartbeatResult | { readonly status: 'IDEMPOTENT' };

export type RemoteFinishResult = 'ACCEPTED' | 'STALE_LEASE';
export type RemoteCompleteResult = 'ACCEPTED' | 'IDEMPOTENT' | 'STALE_LEASE';
const ARTIFACT_TRANSFER_LEASE_MS = 15 * 60_000;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Lightsail control plane의 원격 worker lease 수명주기.
 * 네트워크·HTTP는 모르고, token 원문은 claim 응답 이후 메모리에도 보관하지 않는다.
 */
export class RemoteWorkerService {
  readonly events = new EventEmitter();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queue: JobQueue,
    private readonly config: AppConfig,
    private readonly expectedRunnerVersion: string,
    private readonly clock: Clock,
    private readonly audit: AuditLogService,
    private readonly logger: Logger,
    private readonly resultCompleter: RemoteResultCompleter,
    private readonly leaseTokenFactory: () => string = () => randomBytes(32).toString('base64url'),
  ) {}

  start(): void {
    this.sweepExpiredLeases();
    const intervalMs = Math.max(5_000, Math.floor(this.leaseDurationMs() / 2));
    this.sweepTimer = setInterval(() => this.sweepExpiredLeases(), intervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  claim(workerId: string, runnerVersion: string): RemoteClaimResult {
    if (runnerVersion !== this.expectedRunnerVersion) {
      return { status: 'VERSION_MISMATCH', expectedRunnerVersion: this.expectedRunnerVersion };
    }
    const nowMs = this.clock.now();
    const leaseToken = this.leaseTokenFactory();
    const leaseExpiresAtMs = nowMs + this.leaseDurationMs();
    const remoteWorkerId = `remote:${workerId}`;
    const job = this.queue.claimNextRemote({
      workerId: remoteWorkerId,
      leaseTokenHash: tokenHash(leaseToken),
      leaseExpiresAtMs,
      runnerVersion,
      maxAttempts: this.config.remoteBacktestMaxAttempts,
    });
    if (job === null) return { status: 'EMPTY' };

    this.audit.record('system', 'backtest.remote-leased', {
      jobId: job.id,
      workerId: remoteWorkerId,
      attempt: job.attempt,
      leaseExpiresAtMs,
      runnerVersion,
    });
    this.events.emit('job', { jobId: job.id, kind: 'status' } satisfies JobEvent);
    return {
      status: 'CLAIMED',
      lease: {
        job,
        attempt: job.attempt,
        leaseToken,
        leaseExpiresAtMs,
        runnerVersion,
      },
    };
  }

  heartbeat(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly processedBars?: number;
    readonly totalBars?: number;
    readonly progressLabel?: string | null;
  }): RemoteHeartbeatResult {
    const nowMs = this.clock.now();
    const leaseExpiresAtMs = nowMs + this.leaseDurationMs();
    const status = this.queue.heartbeatRemote({
      jobId: input.jobId,
      attempt: input.attempt,
      leaseTokenHash: tokenHash(input.leaseToken),
      nowMs,
      nextLeaseExpiresAtMs: leaseExpiresAtMs,
      processedBars: input.processedBars ?? null,
      totalBars: input.totalBars ?? null,
      progressLabel: input.progressLabel ?? null,
    });
    if (status === null) return { status: 'STALE_LEASE' };
    this.events.emit(
      'job',
      { jobId: input.jobId, kind: input.processedBars === undefined ? 'status' : 'progress' } satisfies JobEvent,
    );
    return {
      status: 'ACCEPTED',
      cancelRequested: status === 'CANCELLING',
      leaseExpiresAtMs,
    };
  }

  /** snapshot 생성·다운로드나 결과 업로드 중 일반 heartbeat 간격을 넘겨도 재claim하지 않게 한다. */
  reserveArtifactTransfer(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
  }): RemoteHeartbeatResult {
    const nowMs = this.clock.now();
    const leaseExpiresAtMs = nowMs + Math.max(this.leaseDurationMs(), ARTIFACT_TRANSFER_LEASE_MS);
    const status = this.queue.heartbeatRemote({
      jobId: input.jobId,
      attempt: input.attempt,
      leaseTokenHash: tokenHash(input.leaseToken),
      nowMs,
      nextLeaseExpiresAtMs: leaseExpiresAtMs,
      processedBars: null,
      totalBars: null,
      progressLabel: null,
    });
    if (status === null) return { status: 'STALE_LEASE' };
    return {
      status: 'ACCEPTED',
      cancelRequested: status === 'CANCELLING',
      leaseExpiresAtMs,
    };
  }

  /** 응답 유실 뒤 같은 checksum을 재업로드하는 경우 body를 다시 받기 전에 완료를 확인한다. */
  reserveResultTransfer(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly checksum: string;
  }): RemoteResultTransferResult {
    const job = this.queue.getJob(input.jobId);
    if (
      job?.status === 'COMPLETED'
      && job.attempt === input.attempt
      && job.resultChecksum === input.checksum
    ) return { status: 'IDEMPOTENT' };
    return this.reserveArtifactTransfer(input);
  }

  finish(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly outcome: 'FAILED' | 'CANCELLED';
    readonly error?: string;
    readonly telemetry?: BacktestExecutionTelemetry;
  }): RemoteFinishResult {
    const job = this.queue.getJob(input.jobId);
    const finishedAtMs = this.clock.now();
    const accepted = this.queue.finishRemote({
      jobId: input.jobId,
      attempt: input.attempt,
      leaseTokenHash: tokenHash(input.leaseToken),
      nowMs: finishedAtMs,
      status: input.outcome,
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    if (!accepted) return 'STALE_LEASE';

    this.audit.record('system', 'backtest.finished', {
      jobId: input.jobId,
      status: input.outcome,
      durationMs: finishedAtMs - (job?.startedAtMs ?? job?.createdAtMs ?? finishedAtMs),
      executionMode: 'remote',
      attempt: input.attempt,
      ...(input.telemetry === undefined ? {} : { executionTelemetry: input.telemetry }),
    });
    this.events.emit('job', { jobId: input.jobId, kind: 'status' } satisfies JobEvent);
    return 'ACCEPTED';
  }

  async complete(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly artifactPath: string;
    readonly checksum: string;
    readonly telemetry?: BacktestExecutionTelemetry;
  }): Promise<RemoteCompleteResult> {
    const job = this.queue.getJob(input.jobId);
    const completed = await this.resultCompleter.complete({
      jobId: input.jobId,
      attempt: input.attempt,
      leaseTokenHash: tokenHash(input.leaseToken),
      artifactPath: input.artifactPath,
      checksum: input.checksum,
      expectedRunnerVersion: this.expectedRunnerVersion,
    });
    if (completed.status !== 'ACCEPTED') return completed.status;

    this.audit.record('system', 'backtest.finished', {
      jobId: input.jobId,
      status: 'COMPLETED',
      durationMs: completed.completedAtMs
        - (job?.startedAtMs ?? job?.createdAtMs ?? completed.completedAtMs),
      executionMode: 'remote',
      attempt: input.attempt,
      resultSchemaVersion: completed.schemaVersion,
      resultChecksum: input.checksum,
      resultRowCount: completed.rowCount,
      ...(input.telemetry === undefined ? {} : { executionTelemetry: input.telemetry }),
    });
    this.events.emit('job', { jobId: input.jobId, kind: 'status' } satisfies JobEvent);
    return 'ACCEPTED';
  }

  sweepExpiredLeases(): void {
    const recovered = this.queue.recoverExpiredRemoteLeases(this.config.remoteBacktestMaxAttempts);
    for (const item of recovered) {
      this.logger.warn(
        {
          module: 'backtest',
          event: 'backtest.remote-lease-expired',
          jobId: item.jobId,
          attempt: item.attempt,
          status: item.status,
        },
        'remote backtest lease expired',
      );
      this.audit.record('system', 'backtest.remote-lease-expired', { ...item });
      this.events.emit('job', { jobId: item.jobId, kind: 'status' } satisfies JobEvent);
    }
  }

  private leaseDurationMs(): number {
    return this.config.remoteBacktestLeaseSeconds * 1_000;
  }
}
