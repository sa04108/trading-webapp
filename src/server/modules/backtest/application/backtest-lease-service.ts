import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  AGENT_LEASE_MS,
  AGENT_MAX_ATTEMPTS,
  LOCAL_AGENT_ID,
} from "../../../../shared/agent-protocol.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import type { Logger } from "../../../shared/logger.js";
import { isPersistenceUnavailableError } from "../../../shared/db/sqlite-errors.js";
import type { AuditLogService } from "../../../../runtime/modules/audit/audit-service.js";
import type { BacktestExecutionTelemetry } from "../../../../runtime/modules/backtest/application/backtest-execution-telemetry.js";
import type { BacktestJobRow, JobQueue } from "./job-queue.js";
import type { JobEvent } from "./job-orchestrator.js";
import {
  BacktestResultImportInternalError,
  BacktestResultPersistenceUnavailableError,
  type BacktestResultCompleter,
} from "../../../../runtime/modules/backtest/application/backtest-result-artifact.js";

export interface BacktestJobLease {
  readonly job: BacktestJobRow;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
  readonly runnerVersion: string;
}

export type BacktestClaimResult =
  | { readonly status: "CLAIMED"; readonly lease: BacktestJobLease }
  | { readonly status: "EMPTY" }
  | {
      readonly status: "VERSION_MISMATCH";
      readonly expectedRunnerVersion: string;
    };

export type BacktestHeartbeatResult =
  | {
      readonly status: "ACCEPTED";
      readonly cancelRequested: boolean;
      readonly leaseExpiresAtMs: number;
    }
  | { readonly status: "STALE_LEASE" };
export type BacktestResultTransferResult =
  BacktestHeartbeatResult | { readonly status: "IDEMPOTENT" };

export type BacktestFinishResult = "ACCEPTED" | "STALE_LEASE";
export type BacktestCompleteResult =
  "ACCEPTED" | "IDEMPOTENT" | "IDENTITY_REJECTED" | "STALE_LEASE";
const ARTIFACT_TRANSFER_LEASE_MS = 15 * 60_000;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * 서버가 로컬·원격 에이전트에 발급한 백테스트 임대의 수명주기를 관리한다.
 * 네트워크·HTTP는 모르고, token 원문은 claim 응답 이후 메모리에도 보관하지 않는다.
 */
export class BacktestLeaseService {
  readonly events = new EventEmitter();
  private sweepTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private stoppingPromise: Promise<void> | null = null;
  private readonly completions = new Set<Promise<BacktestCompleteResult>>();

  constructor(
    private readonly queue: JobQueue,
    private readonly expectedRunnerVersion: string,
    private readonly clock: Clock,
    private readonly audit: AuditLogService,
    private readonly logger: Logger,
    private readonly resultCompleter: BacktestResultCompleter,
    private readonly leaseTokenFactory: () => string = () =>
      randomBytes(32).toString("base64url"),
  ) {}

  start(): void {
    this.sweepExpiredLeases();
    const intervalMs = Math.max(5_000, Math.floor(this.leaseDurationMs() / 2));
    this.sweepTimer = setInterval(() => this.sweepExpiredLeases(), intervalMs);
    this.sweepTimer.unref();
  }

  stop(): Promise<void> {
    if (this.stoppingPromise !== null) return this.stoppingPromise;
    this.stopping = true;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.stoppingPromise = this.stopOnce();
    return this.stoppingPromise;
  }

  private async stopOnce(): Promise<void> {
    await this.resultCompleter.stop();
    await Promise.allSettled([...this.completions]);
  }

  claim(
    agentId: string,
    runnerVersion: string,
    maxBars = Number.MAX_SAFE_INTEGER,
    jobId?: string,
  ): BacktestClaimResult {
    if (runnerVersion !== this.expectedRunnerVersion) {
      return {
        status: "VERSION_MISMATCH",
        expectedRunnerVersion: this.expectedRunnerVersion,
      };
    }
    const nowMs = this.clock.now();
    const leaseToken = this.leaseTokenFactory();
    const leaseExpiresAtMs = nowMs + this.leaseDurationMs();
    const job = this.queue.claimNextLease({
      agentId,
      leaseTokenHash: tokenHash(leaseToken),
      leaseExpiresAtMs,
      runnerVersion,
      maxAttempts: AGENT_MAX_ATTEMPTS,
      maxBars,
      jobId,
    });
    if (job === null) return { status: "EMPTY" };

    this.recordAudit("backtest.leased", {
      jobId: job.id,
      agentId,
      attempt: job.attempt,
      leaseExpiresAtMs,
      runnerVersion,
    });
    this.emitJob({ jobId: job.id, kind: "status" });
    return {
      status: "CLAIMED",
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
    readonly activity?: import("../../../../shared/execution-progress.js").ExecutionActivity;
  }): BacktestHeartbeatResult {
    const nowMs = this.clock.now();
    const leaseExpiresAtMs = nowMs + this.leaseDurationMs();
    const status = this.queue.heartbeatLease({
      jobId: input.jobId,
      attempt: input.attempt,
      leaseTokenHash: tokenHash(input.leaseToken),
      nowMs,
      nextLeaseExpiresAtMs: leaseExpiresAtMs,
      processedBars: input.processedBars ?? null,
      totalBars: input.totalBars ?? null,
      progressLabel: input.progressLabel ?? null,
      activity: input.activity ?? null,
    });
    if (status === null) return { status: "STALE_LEASE" };
    this.emitJob({
      jobId: input.jobId,
      kind: input.processedBars === undefined ? "status" : "progress",
    });
    return {
      status: "ACCEPTED",
      cancelRequested: status === "CANCELLING",
      leaseExpiresAtMs,
    };
  }

  /** snapshot 생성·다운로드나 결과 업로드 중 일반 heartbeat 간격을 넘겨도 재claim하지 않게 한다. */
  reserveArtifactTransfer(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
  }): BacktestHeartbeatResult {
    const nowMs = this.clock.now();
    const leaseExpiresAtMs =
      nowMs + Math.max(this.leaseDurationMs(), ARTIFACT_TRANSFER_LEASE_MS);
    const status = this.queue.heartbeatLease({
      jobId: input.jobId,
      attempt: input.attempt,
      leaseTokenHash: tokenHash(input.leaseToken),
      nowMs,
      nextLeaseExpiresAtMs: leaseExpiresAtMs,
      processedBars: null,
      totalBars: null,
      progressLabel: null,
      activity: null,
    });
    if (status === null) return { status: "STALE_LEASE" };
    return {
      status: "ACCEPTED",
      cancelRequested: status === "CANCELLING",
      leaseExpiresAtMs,
    };
  }

  reportActivity(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly activity: import("../../../../shared/execution-progress.js").ExecutionActivity;
    readonly completed?: number | null;
    readonly total?: number | null;
  }): boolean {
    const accepted = this.queue.updateLeaseActivity({
      ...input,
      leaseTokenHash: tokenHash(input.leaseToken),
      nowMs: this.clock.now(),
    });
    if (accepted) this.emitJob({ jobId: input.jobId, kind: "progress" });
    return accepted;
  }

  /** 응답 유실 뒤 같은 checksum을 재업로드하는 경우 body를 다시 받기 전에 완료를 확인한다. */
  reserveResultTransfer(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly checksum: string;
  }): BacktestResultTransferResult {
    const job = this.queue.getJob(input.jobId);
    if (
      job?.status === "COMPLETED" &&
      job.attempt === input.attempt &&
      job.resultChecksum === input.checksum
    )
      return { status: "IDEMPOTENT" };
    return this.reserveArtifactTransfer(input);
  }

  finish(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly outcome: "FAILED" | "CANCELLED";
    readonly cancelPath?: "IPC" | "SIGTERM" | "SIGKILL";
    readonly error?: string;
    readonly telemetry?: BacktestExecutionTelemetry;
  }): BacktestFinishResult {
    const job = this.queue.getJob(input.jobId);
    const finishedAtMs = this.clock.now();
    const outcome = this.queue.finishLease({
      jobId: input.jobId,
      attempt: input.attempt,
      leaseTokenHash: tokenHash(input.leaseToken),
      nowMs: finishedAtMs,
      status: input.outcome,
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    if (outcome === null) return "STALE_LEASE";

    this.recordAudit("backtest.finished", {
      jobId: input.jobId,
      status: outcome,
      ...(input.cancelPath ? { cancelPath: input.cancelPath } : {}),
      durationMs:
        finishedAtMs - (job?.startedAtMs ?? job?.createdAtMs ?? finishedAtMs),
      executionMode: job?.agentId === LOCAL_AGENT_ID ? "local" : "remote",
      attempt: input.attempt,
      // CANCELLING과 worker FAILED 보고가 경합하면 DB의 실제 결과는 CANCELLED다.
      // 그때 FAILED telemetry를 CANCELLED 감사 행에 붙이지 않는다.
      ...(input.telemetry?.outcome === outcome
        ? { executionTelemetry: input.telemetry }
        : {}),
    });
    this.emitJob({ jobId: input.jobId, kind: "status" });
    return "ACCEPTED";
  }

  defer(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly reason: string;
  }): BacktestFinishResult {
    const job = this.queue.getJob(input.jobId);
    const deferredAtMs = this.clock.now();
    const status = this.queue.deferLease({
      jobId: input.jobId,
      attempt: input.attempt,
      leaseTokenHash: tokenHash(input.leaseToken),
      nowMs: deferredAtMs,
      reason: input.reason,
    });
    if (status === null) return "STALE_LEASE";

    this.recordAudit("backtest.deferred", {
      jobId: input.jobId,
      status,
      reason: input.reason,
      durationMs:
        deferredAtMs - (job?.startedAtMs ?? job?.createdAtMs ?? deferredAtMs),
      executionMode: job?.agentId === LOCAL_AGENT_ID ? "local" : "remote",
      attempt: input.attempt,
    });
    this.emitJob({ jobId: input.jobId, kind: "status" });
    return "ACCEPTED";
  }

  async complete(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly artifactPath: string;
    readonly checksum: string;
    readonly telemetry?: BacktestExecutionTelemetry;
  }): Promise<BacktestCompleteResult> {
    if (this.stopping)
      throw new BacktestResultPersistenceUnavailableError(
        "서버가 종료 중이어서 결과를 저장할 수 없습니다.",
      );
    const completion = this.completeOnce(input);
    this.completions.add(completion);
    void completion.then(
      () => this.completions.delete(completion),
      () => this.completions.delete(completion),
    );
    return completion;
  }

  private async completeOnce(input: {
    readonly jobId: string;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly artifactPath: string;
    readonly checksum: string;
    readonly telemetry?: BacktestExecutionTelemetry;
  }): Promise<BacktestCompleteResult> {
    let job: BacktestJobRow | null;
    try {
      job = this.queue.getJob(input.jobId);
    } catch (error) {
      if (isPersistenceUnavailableError(error)) {
        throw new BacktestResultPersistenceUnavailableError(
          "결과 저장 직전 중앙 작업 정보를 일시적으로 읽을 수 없습니다.",
          { cause: error },
        );
      }
      throw new BacktestResultImportInternalError(
        "결과 저장 직전 중앙 작업 정보를 읽는 데 실패했습니다.",
        { cause: error },
      );
    }
    const completed = await this.resultCompleter.complete({
      jobId: input.jobId,
      attempt: input.attempt,
      leaseTokenHash: tokenHash(input.leaseToken),
      artifactPath: input.artifactPath,
      checksum: input.checksum,
      expectedRunnerVersion: this.expectedRunnerVersion,
    });
    if (completed.status === "IDENTITY_REJECTED") {
      this.recordAudit("backtest.finished", {
        jobId: input.jobId,
        status: "FAILED",
        durationMs:
          completed.completedAtMs -
          (job?.startedAtMs ?? job?.createdAtMs ?? completed.completedAtMs),
        executionMode: job?.agentId === LOCAL_AGENT_ID ? "local" : "remote",
        attempt: input.attempt,
      });
      this.emitJob({ jobId: input.jobId, kind: "status" });
      return "IDENTITY_REJECTED";
    }
    if (completed.status !== "ACCEPTED") return completed.status;

    this.recordAudit("backtest.finished", {
      jobId: input.jobId,
      status: "COMPLETED",
      durationMs:
        completed.completedAtMs -
        (job?.startedAtMs ?? job?.createdAtMs ?? completed.completedAtMs),
      executionMode: job?.agentId === LOCAL_AGENT_ID ? "local" : "remote",
      attempt: input.attempt,
      resultSchemaVersion: completed.schemaVersion,
      resultChecksum: input.checksum,
      resultRowCount: completed.rowCount,
      ...(input.telemetry === undefined
        ? {}
        : { executionTelemetry: input.telemetry }),
    });
    this.emitJob({ jobId: input.jobId, kind: "status" });
    return "ACCEPTED";
  }

  sweepExpiredLeases(): void {
    let recovered: ReturnType<JobQueue["recoverExpiredLeases"]>;
    try {
      recovered = this.queue.recoverExpiredLeases(AGENT_MAX_ATTEMPTS);
    } catch (error) {
      // 결과 import처럼 별도 프로세스가 긴 SQLite write transaction을 잡는 동안에는
      // busy_timeout을 넘길 수 있다. 주기 timer의 예외를 밖으로 던지면 Node의
      // uncaughtException이 되어 웹/control plane 전체가 종료되므로 다음 sweep에서 재시도한다.
      this.logger.warn(
        {
          module: "backtest",
          event: "backtest.lease-sweep-failed",
          err: error,
        },
        "백테스트 임대 회수 실패 — 다음 주기에 재시도합니다",
      );
      return;
    }
    for (const item of recovered) {
      this.logger.warn(
        {
          module: "backtest",
          event: "backtest.lease-expired",
          jobId: item.jobId,
          attempt: item.attempt,
          status: item.status,
        },
        "백테스트 임대 만료",
      );
      this.recordAudit("backtest.lease-expired", { ...item });
      this.emitJob({ jobId: item.jobId, kind: "status" });
    }
  }

  private recordAudit(event: string, detail: Record<string, unknown>): void {
    try {
      this.audit.record("system", event, detail);
    } catch (error) {
      // lease/status는 이미 중앙 DB에 확정됐다. 부가 감사 기록 실패 때문에 에이전트에 5xx를
      // 돌려 같은 계산을 재시도시키지 않고 구조화 로그를 남긴다.
      this.logger.warn(
        {
          module: "backtest",
          event: "backtest.audit-failed",
          auditEvent: event,
          err: error,
        },
        "백테스트 감사 기록 실패",
      );
    }
  }

  private emitJob(event: JobEvent): void {
    try {
      this.events.emit("job", event);
    } catch (error) {
      // 알림·seed batch 승격 같은 후속 listener가 핵심 lease 응답을 실패로 바꾸지 않게 한다.
      this.logger.warn(
        {
          module: "backtest",
          event: "backtest.listener-failed",
          jobId: event.jobId,
          err: error,
        },
        "백테스트 이벤트 리스너 실패",
      );
    }
  }

  private leaseDurationMs(): number {
    return AGENT_LEASE_MS;
  }
}
