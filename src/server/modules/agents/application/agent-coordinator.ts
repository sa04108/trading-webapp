import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { AgentClient } from "../../../../agent/client.js";
import { availableServerResources } from "../../../../agent/resources.js";
import { backtestMemoryPlan, type BacktestMemoryPlan } from "../../../../runtime/modules/backtest/application/backtest-memory-plan.js";
import { BacktestResultArtifactRejectedError } from "../../../../runtime/modules/backtest/application/backtest-result-artifact.js";
import { InvalidBacktestResultArtifactError } from "../../backtest/infrastructure/sqlite-backtest-result-artifact-importer.js";
import { backtestExecutionTelemetrySchema } from "../../../../runtime/modules/backtest/application/backtest-execution-telemetry.js";
import type { WebSocket } from "ws";
import { MAX_BACKTEST_BARS } from "../../../shared/backtest-limits.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { Logger } from "../../../shared/logger.js";
import type { BacktestLeaseService } from "../../backtest/application/backtest-lease-service.js";
import type { BacktestJobRow, JobQueue } from "../../backtest/application/job-queue.js";
import {
  LOCAL_AGENT_ID,
  AGENT_MAX_ATTEMPTS,
  agentMessageSchema,
  type AgentMessage,
  type AgentLease,
  type ServerAgentMessage,
  type DatasetManifest,
} from "../../../../shared/agent-protocol.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { DatasetSnapshots } from "./dataset-snapshots.js";
import type { AgentPreparationQueue } from "./agent-preparation-queue.js";
import type { AgentDataQueue } from "./agent-data-queue.js";
import type { BacktestPreparationJobDto } from "../../../../runtime/modules/backtest/application/backtest-preparation-orchestrator.js";
import type { ExecutionProgress } from "../../../../shared/execution-progress.js";
import { createAuditLogService } from "../../../../runtime/modules/audit/audit-service.js";
import { systemClock } from "../../../../runtime/shared/clock.js";
import { recordWorkerDiagnostics } from "./agent-diagnostic-recorder.js";

interface Connection {
  socket: {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
  };
  ready: boolean;
  slots: number;
  maxBars: number;
  datasetVersion: number;
  lastMessageAt: number;
  deviceProgress?: Extract<AgentMessage, { type: "DEVICE_ACTIVITY" }>["progress"];
}

export class AgentCoordinatorStoppingError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("서버가 종료 중이어서 결과를 처리할 수 없습니다.");
    this.name = "AgentCoordinatorStoppingError";
  }
}

/** PC가 먼저 만든 연결로 서버가 작업을 전달한다. 연결과 작업 lease의 수명은 분리한다. */
export class AgentCoordinator {
  private readonly connections = new Map<string, Connection>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastPrunedAt = 0;
  private dispatching: Promise<void> | null = null;
  private dispatchRequested = false;
  private localClient: AgentClient | null = null;
  private localConnection: Connection | null = null;
  private refreshingLocal = false;
  private closing: Promise<void> | null = null;
  private readonly messageOperations = new Set<Promise<void>>();
  private readonly resultOperations = new Set<Promise<unknown>>();
  private readonly resultAbort = new AbortController();
  private readonly progressEpoch = randomUUID();
  private readonly progressRevisions = new Map<string, { signature: string; revision: number }>();
  private lastQueueDiagnosticAt = Number.NEGATIVE_INFINITY;
  private readonly preparationPhases = new Map<string, { phase: string; pass: number; started: number }>();
  private readonly localMemoryPlans = new Map<string, { plan: BacktestMemoryPlan; complete: boolean }>();
  private memorySampling: { jobId: string; progress: ExecutionProgress } | null = null;
  private lastSamplingNotificationAt = 0;
  private readonly startingPreparations = new Map<string, number>();

  constructor(
    private readonly database: DatabaseHandle,
    readonly registry: AgentRegistry,
    readonly snapshots: DatasetSnapshots,
    readonly preparations: AgentPreparationQueue,
    readonly dataQueue: AgentDataQueue,
    readonly backtests: BacktestLeaseService,
    private readonly queue: JobQueue,
    readonly runnerVersion: string,
    private readonly logger: Logger,
    private readonly executionVersion: string,
  ) {
    this.queue.events.on("queued", this.wake);
    this.backtests.events.on("job", this.wake);
  }

  start(options: { local?: boolean } = {}): void {
    if (this.timer || this.stopped) return;
    this.dataQueue.recover();
    this.backtests.start();
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
    if (options.local !== false) this.startLocal();
    this.wake();
  }

  connect(clientId: string, socket: WebSocket): void {
    if (this.stopped) {
      socket.close(1012, "server stopping");
      return;
    }
    this.connections.get(clientId)?.socket.close(4001, "connection replaced");
    const connection: Connection = {
      socket,
      ready: false,
      slots: 0,
      maxBars: 0,
      datasetVersion: 0,
      lastMessageAt: Date.now(),
    };
    this.connections.set(clientId, connection);
    // 비동기 DB 게시 전에 수신기를 등록해야 HELLO가 유실되지 않는다.
    let tail = Promise.resolve();
    socket.on("message", (data, binary) => {
      tail = tail
        .then(async () => {
          if (this.connections.get(clientId) !== connection) return;
          if (binary || !this.registry.active(clientId)) {
            socket.close(4003, "unauthorized");
            return;
          }
          const message = agentMessageSchema.parse(JSON.parse(data.toString()));
          connection.lastMessageAt = Date.now();
          this.registry.touch(clientId);
          await this.message(clientId, connection, message);
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, clientId },
            "에이전트 메시지 처리 실패",
          );
          socket.close(4002, "invalid message or state");
        });
      this.track(this.messageOperations, tail);
    });
    socket.on("error", (error) =>
      this.logger.debug({ err: error, clientId }, "에이전트 연결 오류"),
    );
    socket.once("close", () => {
      if (this.connections.get(clientId) === connection)
        this.connections.delete(clientId);
      this.wake();
    });
  }

  private send(connection: Connection, message: ServerAgentMessage): void {
    if (connection.socket.readyState === 1)
      connection.socket.send(JSON.stringify(message));
  }

  private async message(
    clientId: string,
    connection: Connection,
    message: AgentMessage,
  ): Promise<void> {
    if (message.type === "HELLO") {
      if (message.runnerVersion !== this.runnerVersion) {
        connection.ready = false;
        connection.slots = 0;
        this.invalidateClientLeases(clientId);
        this.send(connection, {
          type: "UPDATE_REQUIRED",
          runnerVersion: this.runnerVersion,
        });
        return;
      }
      connection.ready = true;
      this.send(connection, {
        type: "WELCOME",
        runnerVersion: this.runnerVersion,
      });
      if (clientId === LOCAL_AGENT_ID) {
        this.wake();
        return;
      }
      const dataset = await this.snapshots.ensureLatest();
      this.send(connection, { type: "DATASET", dataset });
      return;
    }
    if (!connection.ready) throw new Error("HELLO가 필요합니다");
    if (message.type === "CAPACITY") {
      connection.slots = message.slots;
      connection.maxBars = message.maxBars;
      connection.datasetVersion = message.datasetVersion;
      if (
        connection.deviceProgress &&
        connection.deviceProgress.datasetVersion <= message.datasetVersion
      )
        connection.deviceProgress = undefined;
      if (!this.refreshingLocal || clientId !== LOCAL_AGENT_ID) this.wake();
      return;
    }
    if (message.type === "DEVICE_ACTIVITY") {
      connection.deviceProgress = message.progress;
      this.notifyQueuedProgress();
      return;
    }
    const identity = {
      jobId: message.jobId,
      attempt: message.attempt,
      leaseToken: message.leaseToken,
    };
    if (message.type === "HEARTBEAT") {
      if (message.kind === "PREPARATION") {
        const result = this.preparations.heartbeat(clientId, identity, message.preparationProgress);
        if (result.accepted && message.preparationProgress) {
          if (this.startingPreparations.delete(`${message.jobId}:${message.attempt}`))
            this.preparations.notify(message.jobId, true);
          const progress = message.preparationProgress;
          const key = `${message.jobId}:${message.attempt}`;
          const previous = this.preparationPhases.get(key);
          if (!previous || previous.phase !== progress.phase || previous.pass !== progress.resolutionPass) {
            this.logger.info({ event: "preparation.phase", jobId: message.jobId, attempt: message.attempt,
              clientId, phase: progress.phase, resolutionPass: progress.resolutionPass,
              previousPhase: previous?.phase, previousPhaseElapsedMs: previous ? performance.now() - previous.started : undefined,
              doneSymbols: progress.doneSymbols, totalSymbols: progress.totalSymbols,
            }, "미리보기 계산 단계 변경");
            // 이전 임대의 마지막 메시지가 유실돼도 진단 상태가 무한히 남지 않는다.
            if (this.preparationPhases.size >= 256) this.preparationPhases.delete(this.preparationPhases.keys().next().value!);
            this.preparationPhases.set(key, { phase: progress.phase, pass: progress.resolutionPass, started: performance.now() });
          }
        }
        this.send(connection, {
          type: "LEASE",
          kind: message.kind,
          ...identity,
          ...result,
        });
      } else {
        if (!this.ownsBacktest(clientId, message.jobId)) {
          this.send(connection, {
            type: "LEASE",
            kind: message.kind,
            ...identity,
            accepted: false,
            cancelRequested: false,
          });
          return;
        }
        const result = this.backtests.heartbeat({
          ...identity,
          ...message.progress,
        });
        this.send(connection, {
          type: "LEASE",
          kind: message.kind,
          ...identity,
          accepted: result.status === "ACCEPTED",
          cancelRequested:
            result.status === "ACCEPTED" && result.cancelRequested,
          ...(result.status === "ACCEPTED"
            ? { leaseExpiresAtMs: result.leaseExpiresAtMs }
            : {}),
        });
      }
      return;
    }
    let accepted = false;
    if (message.type === "DEFER") {
      // 새 메시지는 내부 실행기의 시작 전 반환에만 허용한다. 기존 원격 완료 계약은 그대로다.
      if (clientId === LOCAL_AGENT_ID && this.ownsBacktest(clientId, message.jobId)) {
        accepted = this.backtests.defer({
          ...identity,
          reason: `로컬 메모리 여유 대기 (필요 ${message.requiredBytes}, 가용 ${message.availableBytes} bytes)`,
        }) === "ACCEPTED";
      }
    } else if (message.type === "NEEDS_DATA") {
      if (message.kind === "PREPARATION") {
        try {
          accepted = this.preparations.waitForData(clientId, identity, () => {
            this.dataQueue.request(
              message.kind,
              message.jobId,
              this.preparations.datasetVersion(message.jobId)!,
              message.request,
            );
          });
        } catch (error) {
          accepted = this.preparations.finish(
            clientId,
            identity,
            "FAILED",
            null,
            null,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } else if (message.kind === "PREPARATION") {
      const version = this.preparations.datasetVersion(message.jobId);
      const dataset = version === null ? null : this.snapshots.get(version);
      accepted = this.preparations.finish(
        clientId,
        identity,
        message.outcome,
        message.result,
        dataset,
        message.error,
      );
    } else if (
      this.ownsBacktest(clientId, message.jobId) &&
      message.outcome !== "COMPLETED"
    ) {
      const telemetry = backtestExecutionTelemetrySchema.safeParse(
        message.result?.telemetry,
      );
      const cancelPath = message.result?.cancelPath;
      accepted =
        this.backtests.finish({
          ...identity,
          outcome: message.outcome,
          error: message.error,
          ...(telemetry.success ? { telemetry: telemetry.data } : {}),
          ...(["IPC", "SIGTERM", "SIGKILL"].includes(String(cancelPath))
            ? { cancelPath: cancelPath as "IPC" | "SIGTERM" | "SIGKILL" }
            : {}),
        }) === "ACCEPTED";
    }
    if (message.type === "FINISH") {
      recordWorkerDiagnostics({
        accepted, clientId, kind: message.kind, jobId: message.jobId,
        attempt: message.attempt, outcome: message.outcome,
        executionMode: clientId === LOCAL_AGENT_ID ? "local" : "remote",
        runnerVersion: this.runnerVersion, diagnostics: message.result?.diagnostics,
      }, createAuditLogService(this.database.db, systemClock, this.logger), this.logger);
    }
    if (accepted) this.preparationPhases.delete(`${message.jobId}:${message.attempt}`);
    this.send(connection, {
      type: "ACK",
      kind: message.kind,
      jobId: message.jobId,
      attempt: message.attempt,
      accepted,
    });
  }

  /** 버전 변경 시 이전 토큰을 먼저 폐기하고 재배정한다. 늦은 결과는 반영하지 않는다. */
  invalidateClientLeases(clientId: string): void {
    const preparations = this.database.sqlite
      .prepare(
        "SELECT j.id FROM backtest_preparation_jobs j JOIN agent_preparation_leases l ON l.job_id = j.id WHERE client_id = ? AND j.status = 'RUNNING'",
      )
      .all(clientId) as Array<{ id: string }>;
    const backtests = this.database.sqlite
      .prepare(
        "SELECT id FROM backtest_jobs WHERE agent_id = ? AND status IN ('STARTING', 'RUNNING', 'CANCELLING')",
      )
      .all(clientId) as Array<{ id: string }>;
    this.database.sqlite.transaction(() => {
      for (const { id } of preparations) {
        this.database.sqlite
          .prepare(
            "UPDATE backtest_preparation_jobs SET status = CASE WHEN cancel_requested = 1 THEN 'CANCELLED' ELSE 'QUEUED' END, updated_at_ms = ? WHERE id = ?",
          )
          .run(Date.now(), id);
        this.database.sqlite
          .prepare(
            "UPDATE agent_preparation_leases SET lease_token_hash = NULL, lease_expires_at_ms = NULL WHERE job_id = ?",
          )
          .run(id);
      }
      this.database.sqlite
        .prepare(
          "UPDATE backtest_jobs SET status = CASE WHEN status = 'CANCELLING' THEN 'CANCELLED' ELSE 'QUEUED' END, agent_id = NULL, lease_token_hash = NULL, lease_expires_at_ms = NULL WHERE agent_id = ? AND status IN ('STARTING', 'RUNNING', 'CANCELLING')",
        )
        .run(clientId);
    })();
    for (const { id } of preparations) this.preparations.resume(id);
    for (const { id } of backtests)
      this.backtests.events.emit("job", { jobId: id, kind: "status" });
  }

  maxBacktestBars(): number {
    const capacities = [
      ...this.connections.values(),
      ...(this.localConnection ? [this.localConnection] : []),
    ]
      .filter((c) => c.ready && c.socket.readyState === 1 && c.maxBars > 0)
      .map((c) => c.maxBars);
    return Math.max(MAX_BACKTEST_BARS, ...capacities);
  }

  /** 준비 행과 서버 수집·게시·장치 상태를 GET/SSE가 함께 쓰는 한 DTO로 조합한다. */
  preparationView(job: BacktestPreparationJobDto) {
    const progress = this.preparationProgress(job);
    const signature = JSON.stringify([job.status, job.phase, job.overallProgress, progress]);
    const previous = this.progressRevisions.get(job.id);
    const revision = previous?.signature === signature ? previous.revision : (previous?.revision ?? 0) + 1;
    if (this.preparationsIsTerminal(job.status)) this.progressRevisions.delete(job.id);
    else this.progressRevisions.set(job.id, { signature, revision });
    return { ...job, progressEpoch: this.progressEpoch, progressRevision: revision, progress };
  }

  private preparationsIsTerminal(status: string): boolean {
    return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
  }

  private preparationProgress(job: BacktestPreparationJobDto): ExecutionProgress | null {
    if (job.status === "WAITING_DATA" && job.phase !== "FILING_DISCOVERY") {
      const collection = this.dataQueue.progressForJob(job.id);
      const publishing = this.snapshots.publishProgress();
      if (collection && publishing && collection.activity.startsWith("PUBLISHING_"))
        return {
          ...collection,
          activity: publishing.activity,
          startedAtMs: publishing.startedAtMs,
          lastProgressAtMs: publishing.updatedAtMs,
          lastReceivedAtMs: publishing.updatedAtMs,
        };
      return collection;
    }
    const times = this.database.sqlite
      .prepare(
        "SELECT created_at_ms, updated_at_ms FROM backtest_preparation_jobs WHERE id = ?",
      )
      .get(job.id) as { created_at_ms: number; updated_at_ms: number } | undefined;
    const activityAt = times?.updated_at_ms ?? times?.created_at_ms ?? Date.now();
    if (job.status === "WAITING_DATA" && job.phase === "FILING_DISCOVERY") return {
      activity: "FILING_DISCOVERY", detail: "최근 공시 목록을 확인하고 있습니다", actorKind: "SERVER",
      actorId: null, actorName: "운영 서버", unit: null, completed: null, total: null,
      currentItem: null, attempt: null, retryCount: 0, startedAtMs: activityAt,
      lastProgressAtMs: null, lastReceivedAtMs: activityAt, nextResumeAtMs: null,
    };
    if (job.status === "WAITING_DAILY_QUOTA")
      return {
        activity: "WAITING_RETRY", detail: job.error, actorKind: "SERVER",
        actorId: null, actorName: "운영 서버", unit: null, completed: null,
        total: null, currentItem: null, attempt: null, retryCount: 0,
        startedAtMs: activityAt, lastProgressAtMs: null, lastReceivedAtMs: activityAt,
        nextResumeAtMs: job.nextResumeAtMs,
      };
    if (job.status === "RUNNING") {
      const lease = this.database.sqlite.prepare(
        `SELECT l.client_id, l.attempt, l.last_received_at_ms, c.name
         FROM agent_preparation_leases l LEFT JOIN agent_clients c ON c.id = l.client_id
         WHERE l.job_id = ?`,
      ).get(job.id) as { client_id: string; attempt: number; last_received_at_ms: number | null; name: string | null } | undefined;
      const actorKind = lease?.client_id === LOCAL_AGENT_ID ? "SERVER_AGENT" : "REMOTE_AGENT";
      const startingAt = this.startingPreparations.get(`${job.id}:${lease?.attempt}`);
      const activities = {
        FILING_DISCOVERY: "FILING_DISCOVERY",
        MARKET_DATA: "CHECKING_INPUT",
        RESOLVING_STAGES: "RESOLVING_UNIVERSE",
        VALIDATING_RESULT: "VALIDATING_INPUT",
        SYNCING_FACTS: "CHECKING_INPUT",
        FINALIZING: "SAVING_PREVIEW",
      } as const;
      return {
        activity: startingAt === undefined ? activities[job.phase] : "STARTING_WORKER",
        detail: startingAt === undefined ? null : "실행기를 배정했습니다. 계산 프로세스를 시작하고 첫 진행 보고를 기다립니다", actorKind,
        actorId: lease?.client_id ?? null,
        actorName: actorKind === "SERVER_AGENT" ? "운영 서버 내부 agent" : (lease?.name ?? "원격 agent"),
        unit: startingAt === undefined && job.totalSymbols > 0 ? "SYMBOLS" : null,
        completed: startingAt === undefined && job.totalSymbols > 0 ? job.doneSymbols : null,
        total: startingAt === undefined && job.totalSymbols > 0 ? job.totalSymbols : null,
        currentItem: null, attempt: lease?.attempt ?? null, retryCount: 0,
        startedAtMs: startingAt ?? times?.created_at_ms ?? activityAt, lastProgressAtMs: startingAt === undefined ? activityAt : null,
        lastReceivedAtMs: lease?.last_received_at_ms ?? null, nextResumeAtMs: null,
      };
    }
    if (job.status !== "QUEUED") return null;
    return this.queuedProgress(job.id, activityAt);
  }

  /** 배정 전 관측값도 GET과 SSE에서 같은 내용과 단위를 사용한다. */
  backtestProgress(job: BacktestJobRow): ExecutionProgress | null {
    return job.status === "QUEUED"
      ? { ...this.queuedProgress(job.id, job.createdAtMs, job.estimatedBars),
          attempt: job.attempt || null, retryCount: job.leaseFailures }
      : null;
  }

  private queuedProgress(jobId: string, activityAt: number, estimatedBars?: number): ExecutionProgress {
    const base: ExecutionProgress = {
      activity: "WAITING_FOR_EXECUTOR", detail: null,
      actorKind: "SERVER", actorId: null, actorName: "운영 서버 배정기",
      unit: null, completed: null, total: null, currentItem: null,
      attempt: null, retryCount: 0, startedAtMs: activityAt,
      lastProgressAtMs: null, lastReceivedAtMs: null, nextResumeAtMs: null,
    };
    if (this.memorySampling) return this.memorySampling.jobId === jobId
      ? this.memorySampling.progress
      : { ...base, activity: "ASSIGNING_EXECUTOR",
          detail: "배정기가 먼저 대기 중인 백테스트의 입력 크기와 메모리를 확인하고 있습니다. 확인 후 이 작업의 배정을 이어갑니다" };
    const publishing = this.snapshots.publishProgress();
    if (publishing)
      return {
        activity: publishing.activity, detail: null, actorKind: "SERVER", actorId: null,
        actorName: "운영 서버", unit: null, completed: null, total: null,
        currentItem: null, attempt: null, retryCount: 0,
        startedAtMs: publishing.startedAtMs, lastProgressAtMs: publishing.updatedAtMs,
        lastReceivedAtMs: publishing.updatedAtMs, nextResumeAtMs: null,
      };
    const connected = [...this.connections, ...(this.localConnection ? [[LOCAL_AGENT_ID, this.localConnection] as const] : [])]
      .filter(([id, connection]) => connection.ready && connection.socket.readyState === 1 &&
        (id === LOCAL_AGENT_ID || (Date.now() - connection.lastMessageAt <= 60_000 && this.registry.active(id))));
    const memory = this.localMemoryPlans.get(`${this.localConnection?.datasetVersion}:${jobId}`);
    const budget = this.localClient?.localMemoryBudget() ?? 0;
    const capable = connected.filter(([id, connection]) => estimatedBars === undefined ||
      (connection.maxBars >= estimatedBars &&
        (id !== LOCAL_AGENT_ID || !memory || memory.plan.requiredBytes <= budget)));
    const free = capable.filter(([id, connection]) => this.available(id, connection));
    const syncing = capable
      .map(([id, connection]) => ({ id, progress: connection.deviceProgress }))
      .find(({ progress }) => progress !== undefined);
    if (syncing?.progress && free.length === 0) {
      const name = (this.database.sqlite.prepare("SELECT name FROM agent_clients WHERE id = ?").get(syncing.id) as { name: string } | undefined)?.name;
      return {
        activity: syncing.progress.activity, detail: syncing.progress.detail,
        actorKind: "REMOTE_AGENT", actorId: syncing.id, actorName: name ?? "원격 agent",
        unit: syncing.progress.total === null ? null : "BYTES",
        completed: syncing.progress.completed, total: syncing.progress.total,
        currentItem: null, attempt: null, retryCount: 0,
        startedAtMs: syncing.progress.occurredAtMs,
        lastProgressAtMs: syncing.progress.occurredAtMs,
        lastReceivedAtMs: this.connections.get(syncing.id)?.lastMessageAt ?? null,
        nextResumeAtMs: null,
      };
    }
    if (connected.length === 0) return { ...base,
      detail: "연결된 실행기가 없습니다. 운영 서버 내부 실행기 또는 원격 agent 연결을 기다립니다" };
    if (free.length > 0) return { ...base, activity: "ASSIGNING_EXECUTOR",
      detail: `사용 가능한 실행기 ${free.length}개에서 입력 데이터와 배정 순서를 확인합니다${memory?.complete ? ` · 예상 필요 메모리 ${Math.ceil(memory.plan.requiredBytes / 1024 ** 2)} MiB` : ""}` };
    const local = connected.find(([id]) => id === LOCAL_AGENT_ID);
    if (local && (estimatedBars === undefined || local[1].maxBars >= estimatedBars) &&
      this.activeLeaseCount(LOCAL_AGENT_ID) === 0 &&
      ((memory && memory.plan.requiredBytes > budget) || budget < 128 * 1024 ** 2)) return {
      ...base, activity: "WAITING_FOR_MEMORY",
      detail: `운영 서버의 메모리 여유를 기다립니다 · ${memory ? `${memory.complete ? "예상" : "최소"} 필요 ${Math.ceil(memory.plan.requiredBytes / 1024 ** 2)} MiB · ` : ""}현재 가용 ${Math.floor(budget / 1024 ** 2)} MiB · 자원이 확보되면 자동으로 다시 배정합니다`,
    };
    if (capable.length === 0) return { ...base, activity: "WAITING_FOR_CAPACITY",
      detail: `입력 ${estimatedBars?.toLocaleString("ko-KR")}봉을 수용할 실행기를 기다립니다 · 연결된 실행기의 최대 용량 ${Math.max(...connected.map(([, connection]) => connection.maxBars)).toLocaleString("ko-KR")}봉` };
    const active = capable.reduce((count, [id]) => count + this.activeLeaseCount(id), 0);
    return { ...base, activity: "WAITING_FOR_SLOT",
      detail: `실행 가능한 계산 슬롯을 기다립니다 · 연결된 실행기 ${capable.length}개 · 배정된 작업 ${active}개${local ? " · 운영 서버는 CPU·메모리 여유를 확보한 뒤 한 작업씩 실행합니다" : ""}` };
  }

  /** 진행 알림만으로 배정 루프를 다시 깨우지 않는다. */
  notifyQueuedProgress(): void {
    this.preparations.notifyQueued(true);
    const jobs = this.database.sqlite.prepare("SELECT id FROM backtest_jobs WHERE status = 'QUEUED'").all() as Array<{ id: string }>;
    for (const job of jobs) this.queue.events.emit("job", { jobId: job.id, kind: "progress" });
  }

  private reportMemorySampling(jobId: string, completed: number | null, total: number | null, budgetBytes: number): void {
    const now = Date.now();
    const previous = this.memorySampling;
    this.memorySampling = { jobId, progress: {
      activity: "ESTIMATING_JOB_MEMORY",
      detail: `종목별 재무 데이터 크기, 전략 이력, 결과 저장 공간과 최소 입력 묶음의 메모리를 계산합니다 · 현재 가용 ${Math.floor(budgetBytes / 1024 ** 2)} MiB`,
      actorKind: "SERVER", actorId: null, actorName: "운영 서버 배정기",
      unit: total === null ? null : "SYMBOLS", completed, total, currentItem: null,
      attempt: null, retryCount: 0, startedAtMs: previous?.jobId === jobId ? previous.progress.startedAtMs : now,
      lastProgressAtMs: now, lastReceivedAtMs: now, nextResumeAtMs: null,
    } };
    // 종목 집계가 빠른 경우 SSE 직렬화가 계산보다 무거워지지 않게 제한한다.
    if (previous?.jobId !== jobId || now - this.lastSamplingNotificationAt >= 250 || completed === total) {
      this.lastSamplingNotificationAt = now;
      this.notifyQueuedProgress();
    }
  }

  ownsBacktest(clientId: string, jobId: string): boolean {
    return this.queue.getJob(jobId)?.agentId === clientId;
  }

  /** HTTP와 로컬 agent의 결과 수신 전체를 종료 시점까지 추적한다. */
  runResultOperation<T>(
    operation: (shutdownSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.stopped) return Promise.reject(new AgentCoordinatorStoppingError());
    let started: Promise<T>;
    try {
      started = operation(this.resultAbort.signal);
    } catch (error) {
      started = Promise.reject(error);
    }
    const tracked = started.catch((error: unknown) => {
      if (this.resultAbort.signal.aborted)
        throw new AgentCoordinatorStoppingError();
      throw error;
    });
    this.track(this.resultOperations, tracked);
    return tracked;
  }

  private track<T>(operations: Set<Promise<T>>, operation: Promise<T>): void {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
  }

  private async drain(operations: Set<Promise<unknown>>): Promise<void> {
    while (operations.size > 0)
      await Promise.allSettled([...operations]);
  }

  /** 큐 등록·슬롯 반환·재연결은 주기 타이머를 기다리지 않고 배정을 깨운다. */
  readonly wake = (): void => {
    if (this.stopped) return;
    this.dispatchRequested = true;
    if (this.dispatching) return;
    this.dispatching = Promise.resolve()
      .then(async () => {
        while (this.dispatchRequested && !this.stopped) {
          this.dispatchRequested = false;
          await this.dispatch();
        }
      })
      .catch((error: unknown) =>
        this.logger.warn({ err: error }, "계산 작업 배정 실패"),
      )
      .finally(() => {
        this.dispatching = null;
        if (!this.stopped) this.notifyQueuedProgress();
        if (this.dispatchRequested && !this.stopped) this.wake();
      });
  };

  private hasQueuedWork(): boolean {
    return !!this.database.sqlite
      .prepare(
        "SELECT 1 FROM backtest_jobs WHERE status = 'QUEUED' UNION ALL SELECT 1 FROM backtest_preparation_jobs WHERE status = 'QUEUED' AND cancel_requested = 0 LIMIT 1",
      )
      .get();
  }

  private available(clientId: string, connection: Connection): boolean {
    return (
      connection.ready &&
      connection.socket.readyState === 1 &&
      connection.slots > this.activeLeaseCount(clientId) &&
      (clientId === LOCAL_AGENT_ID ||
        (Date.now() - connection.lastMessageAt <= 60_000 &&
          this.registry.active(clientId)))
    );
  }

  private async dispatch(): Promise<void> {
    if (!this.hasQueuedWork()) return;
    this.refreshLocalCapacity();
    if (
      ![...this.connections].some(([id, connection]) =>
        this.available(id, connection),
      ) &&
      !(
        this.localConnection &&
        this.available(LOCAL_AGENT_ID, this.localConnection)
      )
    ) {
      this.logQueueWait();
      return;
    }
    const dataset = await this.snapshots.ensureLatest();
    if (this.stopped) return;
    // 게시를 기다리는 동안 연결된 장치까지 다시 확인한 뒤 서버의 계산 슬롯을 사용한다.
    for (const [id, connection] of this.connections)
      await this.assign(id, connection, dataset);
    if (this.localClient && this.localConnection) {
      this.refreshLocalCapacity();
      await this.assign(LOCAL_AGENT_ID, this.localConnection, dataset);
    }
    this.logQueueWait();
  }

  /** 큐 대기를 실행 실패와 구분하고, 같은 상태는 분당 한 번만 기록한다. */
  private logQueueWait(): void {
    const now = Date.now();
    if (now - this.lastQueueDiagnosticAt < 60_000) return;
    this.lastQueueDiagnosticAt = now;
    const jobs = this.database.sqlite.prepare(`SELECT id, estimated_bars AS estimatedBars, created_at_ms AS createdAtMs
      FROM backtest_jobs WHERE status = 'QUEUED' ORDER BY created_at_ms LIMIT 20`).all() as Array<{ id: string; estimatedBars: number; createdAtMs: number }>;
    const connected = [...this.connections, ...(this.localConnection ? [[LOCAL_AGENT_ID, this.localConnection] as const] : [])]
      .filter(([id, connection]) => connection.ready && connection.socket.readyState === 1 &&
        (id === LOCAL_AGENT_ID || (now - connection.lastMessageAt <= 60_000 && this.registry.active(id))));
    for (const job of jobs) {
      const requiredBytes = this.localMemoryPlans.get(`${this.localConnection?.datasetVersion}:${job.id}`)?.plan.requiredBytes ?? null;
      const localBudgetBytes = this.localClient?.localMemoryBudget() ?? 0;
      const capable = connected.filter(([id, connection]) => connection.maxBars >= job.estimatedBars &&
        (id !== LOCAL_AGENT_ID || requiredBytes === null || requiredBytes <= localBudgetBytes));
      const reason = connected.length === 0 ? "NO_CONNECTED_EXECUTOR"
        : capable.length === 0 ? (requiredBytes !== null && requiredBytes > localBudgetBytes
          ? "MEMORY_UNAVAILABLE" : "CAPACITY_TOO_SMALL")
        : !capable.some(([id, connection]) => this.available(id, connection)) ? "SLOTS_BUSY"
        : "DATASET_OR_DISPATCH_PENDING";
      const fields = { event: "backtest.queue.waiting", jobId: job.id, reason,
        queuedMs: Math.max(0, now - job.createdAtMs), estimatedBars: job.estimatedBars,
        requiredBytes, localBudgetBytes,
        maxConnectedBars: Math.max(0, ...connected.map(([, connection]) => connection.maxBars)),
        connectedExecutors: connected.length, capableExecutors: capable.length };
      if (reason === "CAPACITY_TOO_SMALL") this.logger.warn(fields, "작업 크기를 수용할 에이전트 대기");
      else this.logger.info(fields, "백테스트 실행 대기");
    }
  }

  private refreshLocalCapacity(): void {
    this.refreshingLocal = true;
    try {
      this.localClient?.refreshCapacity();
    } finally {
      this.refreshingLocal = false;
    }
  }

  private async assign(
    clientId: string,
    connection: Connection,
    dataset: DatasetManifest,
  ): Promise<void> {
    if (!this.available(clientId, connection) || this.stopped) return;
    if (connection.datasetVersion !== dataset.version) {
      this.send(connection, { type: "DATASET", dataset });
      return;
    }
    let active = this.activeLeaseCount(clientId);
    while (connection.slots > active) {
      let lease: AgentLease | null;
      const local = clientId === LOCAL_AGENT_ID;
      const candidate = local ? await this.localBacktestCandidate(connection.maxBars, dataset) : null;
      // 집계 중 새 원격 슬롯이 생겼으면 로컬 claim 전에 우선 배정한다.
      if (local)
        for (const [id, remote] of this.connections) await this.assign(id, remote, dataset);
      // 팩트 집계 사이에 취소·종료·다른 배정이 진행될 수 있다.
      if (this.stopped || !this.available(clientId, connection)) return;
      if (candidate && candidate.plan.requiredBytes > (this.localClient?.localMemoryBudget() ?? 0)) return;
      const claim = local && !candidate ? { status: "EMPTY" as const } : this.backtests.claim(
        clientId,
        this.executionVersion,
        connection.maxBars,
        candidate?.jobId,
      );
      if (claim.status === "CLAIMED") {
        const job = claim.lease.job;
        if (candidate?.inputError) {
          this.backtests.finish({
            jobId: job.id, attempt: claim.lease.attempt, leaseToken: claim.lease.leaseToken,
            outcome: "FAILED", error: `[JOB_SETUP_FAILED] ${candidate.inputError}`,
          });
          continue;
        }
        this.database.sqlite
          .prepare(
            "INSERT INTO agent_backtest_datasets (job_id, dataset_version) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET dataset_version = excluded.dataset_version",
          )
          .run(job.id, dataset.version);
        lease = {
          kind: "BACKTEST",
          jobId: job.id,
          attempt: claim.lease.attempt,
          leaseToken: claim.lease.leaseToken,
          leaseExpiresAtMs: claim.lease.leaseExpiresAtMs,
          dataset,
          ...(candidate ? { memoryPlan: candidate.plan } : {}),
          payload: { ...job, preparationJobId: null },
        };
      } else lease = this.preparations.claim(clientId, dataset);
      if (!lease) {
        const waiting = this.database.sqlite
          .prepare(
            "SELECT estimated_bars AS bars FROM backtest_jobs WHERE status = 'QUEUED' ORDER BY created_at_ms LIMIT 1",
          )
          .get() as { bars: number } | undefined;
        // 로컬은 단일 슬롯·메모리 예산이 고정되어 큰 작업의 수요를 반영해도 용량이 늘지 않는다.
        if (clientId !== LOCAL_AGENT_ID && waiting && waiting.bars > connection.maxBars)
          this.send(connection, {
            type: "DEMAND",
            estimatedBars: waiting.bars,
          });
        break;
      }
      active += 1;
      if (lease.kind === "PREPARATION") {
        this.startingPreparations.set(`${lease.jobId}:${lease.attempt}`, Date.now());
        this.preparations.notify(lease.jobId, true);
      }
      this.send(connection, { type: "JOB", lease });
    }
  }

  /** 큰 작업이 기다리는 동안 실행 가능한 작은 작업과 준비 작업까지 막지 않는다. */
  private async localBacktestCandidate(maxBars: number, dataset: DatasetManifest): Promise<{
    jobId: string; plan: BacktestMemoryPlan; inputError?: string;
  } | null> {
    const budgetBytes = this.localClient?.localMemoryBudget() ?? 0;
    const candidates = this.database.sqlite.prepare(`SELECT id FROM backtest_jobs
      WHERE status = 'QUEUED' AND lease_failures < ? AND estimated_bars <= ?
      ORDER BY created_at_ms, id`).all(AGENT_MAX_ATTEMPTS, maxBars) as Array<{ id: string }>;
    let snapshot: Database.Database | undefined;
    try {
      for (const candidate of candidates) {
        const key = `${dataset.version}:${candidate.id}`;
        const cached = this.localMemoryPlans.get(key);
        let plan = cached?.complete ? cached.plan : undefined;
        if (!plan) {
          const job = this.queue.getJob(candidate.id);
          if (!job) continue;
          this.reportMemorySampling(candidate.id, null, null, budgetBytes);
          let factQuery: { symbols: readonly string[]; throughTsMs: number } | undefined;
          plan = backtestMemoryPlan(job, (symbols, throughTsMs) => {
            factQuery = { symbols, throughTsMs };
            return 0;
          });
          if (plan.requiredBytes > budgetBytes) {
            this.rememberMemoryPlan(key, plan, false);
            this.memorySampling = null;
            this.notifyQueuedProgress();
            await yieldImmediate();
            if (this.stopped) return null;
            continue;
          }
          if (factQuery) {
            try {
              this.reportMemorySampling(candidate.id, 0, factQuery.symbols.length, budgetBytes);
              snapshot ??= new Database(this.snapshots.file(dataset), { readonly: true, fileMustExist: true });
              // 종목 키 인덱스로 집계하고 16종목마다 API 이벤트 루프에 양보한다.
              const count = snapshot.prepare(`SELECT count(*) AS count FROM facts
                WHERE scope = 'SYMBOL' AND key = ?
                  AND (as_of_ts_ms <= ? OR field = 'SPLIT_RATIO')`);
              let rows = 0;
              for (let index = 0; index < factQuery.symbols.length; index++) {
                rows += (count.get(factQuery.symbols[index], factQuery.throughTsMs) as { count: number }).count;
                if (index % 16 === 15) {
                  this.reportMemorySampling(candidate.id, index + 1, factQuery.symbols.length, budgetBytes);
                  await yieldImmediate();
                  if (this.stopped) return null;
                }
              }
              this.reportMemorySampling(candidate.id, factQuery.symbols.length, factQuery.symbols.length, budgetBytes);
              plan = backtestMemoryPlan(job, () => rows);
            } catch (error) {
              // 입력 파일 손상·누락을 메모리 대기에 가두지 않는다. claim 후 해당 작업만 실패시킨다.
              return { jobId: candidate.id, plan,
                inputError: `게시 스냅샷을 확인할 수 없습니다: ${error instanceof Error ? error.message : String(error)}` };
            }
          }
          this.rememberMemoryPlan(key, plan, true);
        }
        this.memorySampling = null;
        if (plan.requiredBytes <= budgetBytes) return { jobId: candidate.id, plan };
        await yieldImmediate();
        if (this.stopped) return null;
      }
    } finally {
      this.memorySampling = null;
      snapshot?.close();
    }
    return null;
  }

  private rememberMemoryPlan(key: string, plan: BacktestMemoryPlan, complete: boolean): void {
    if (!this.localMemoryPlans.has(key) && this.localMemoryPlans.size >= 256)
      this.localMemoryPlans.delete(this.localMemoryPlans.keys().next().value!);
    this.localMemoryPlans.set(key, { plan, complete });
  }

  private startLocal(): void {
    let receive: (message: ServerAgentMessage) => void = () => undefined;
    let open = true;
    let tail = Promise.resolve();
    const connection: Connection = {
      socket: {
        get readyState() {
          return open ? 1 : 3;
        },
        send: (data) =>
          queueMicrotask(() => {
            if (open) receive(JSON.parse(data) as ServerAgentMessage);
          }),
        close: () => {
          open = false;
        },
        terminate: () => {
          open = false;
        },
      },
      ready: false,
      slots: 0,
      maxBars: 0,
      datasetVersion: 0,
      lastMessageAt: Date.now(),
    };
    this.localConnection = connection;
    const cache = {
      current: null as DatasetManifest | null,
      syncing: false,
      synchronize: async (manifest: DatasetManifest) => {
        cache.current = manifest;
      },
      file: (manifest: DatasetManifest) => this.snapshots.file(manifest),
      // 게시 파일 보존은 중앙 스케줄러가 원격·로컬 리스를 함께 보고 결정한다.
      prune: () => undefined,
      stop: async () => undefined,
    };
    this.localClient = new AgentClient(
      { serverUrl: "http://localhost", token: "" },
      path.join(path.dirname(this.database.dataPath), "server-agent"),
      undefined,
      (message) => this.logger.info({ module: "local-agent" }, message),
      {
        runnerVersion: this.runnerVersion,
        cache,
        resources: availableServerResources,
        connect: (listener) => {
          receive = listener;
        },
        close: () => connection.socket.terminate(),
        send: (message) => {
          if (!open || this.stopped) return;
          // 배정 직전 자원 측정은 같은 호출 안에서 반영하고 나머지 메시지는 순서대로 처리한다.
          let operation: Promise<void>;
          if (message.type === "CAPACITY") {
            operation = this.message(LOCAL_AGENT_ID, connection, message).catch(
              (error: unknown) =>
                this.logger.warn({ err: error }, "로컬 계산 메시지 처리 실패"),
            );
          } else {
            tail = tail
              .then(() =>
                this.stopped
                  ? undefined
                  : this.message(LOCAL_AGENT_ID, connection, message),
              )
              .catch((error: unknown) =>
                this.logger.warn({ err: error }, "로컬 계산 메시지 처리 실패"),
              );
            operation = tail;
          }
          this.track(this.messageOperations, operation);
        },
        upload: async (input, signal) => {
          return this.runResultOperation(async (shutdownSignal) => {
            signal.throwIfAborted();
            shutdownSignal.throwIfAborted();
            if (!this.ownsBacktest(LOCAL_AGENT_ID, input.lease.jobId)) return 409;
            const identity = {
              jobId: input.lease.jobId,
              attempt: input.lease.attempt,
              leaseToken: input.lease.leaseToken,
              checksum: input.sha256,
            };
            const reserved = this.backtests.reserveResultTransfer(identity);
            if (reserved.status === "IDEMPOTENT") return 200;
            if (reserved.status === "STALE_LEASE" || reserved.cancelRequested)
              return 409;
            try {
              const size = fs.statSync(input.artifactPath).size;
              this.backtests.reportActivity({
                ...input.lease,
                activity: "VALIDATING_RESULT",
                completed: size,
                total: size,
              });
              const status = await this.backtests.complete({
                ...identity,
                artifactPath: input.artifactPath,
                telemetry: input.telemetry,
              });
              return status === "ACCEPTED" || status === "IDEMPOTENT" ? 200 : 409;
            } catch (error) {
              if (
                error instanceof BacktestResultArtifactRejectedError ||
                error instanceof InvalidBacktestResultArtifactError
              )
                return 422;
              throw error;
            }
          });
        },
      },
    );
    this.localClient.start();
  }

  private tick(): void {
    if (this.stopped) return;
    try {
      for (const key of this.startingPreparations.keys()) {
        const separator = key.lastIndexOf(":");
        const row = this.database.sqlite.prepare(`SELECT l.attempt FROM agent_preparation_leases l
          JOIN backtest_preparation_jobs j ON j.id = l.job_id WHERE j.id = ? AND j.status = 'RUNNING'`)
          .get(key.slice(0, separator)) as { attempt: number } | undefined;
        if (row?.attempt !== Number(key.slice(separator + 1))) this.startingPreparations.delete(key);
      }
      this.preparations.sweep();
      this.dataQueue.tick();
      if (Date.now() - this.lastPrunedAt > 60_000) {
        const rows = this.database.sqlite
          .prepare(
            "SELECT dataset_version AS version FROM agent_preparation_leases l JOIN backtest_preparation_jobs j ON j.id = l.job_id WHERE j.status = 'RUNNING' UNION SELECT dataset_version FROM agent_backtest_datasets d JOIN backtest_jobs j ON j.id = d.job_id WHERE j.status IN ('STARTING', 'RUNNING', 'CANCELLING')",
          )
          .all() as Array<{ version: number }>;
        this.snapshots.prune(new Set(rows.map((row) => row.version)));
        this.lastPrunedAt = Date.now();
      }
      const peers = [
        ...this.connections,
        ...(this.localConnection
          ? [[LOCAL_AGENT_ID, this.localConnection] as const]
          : []),
      ];
      for (const [id, connection] of peers) {
        if (
          id !== LOCAL_AGENT_ID &&
          (Date.now() - connection.lastMessageAt > 60_000 ||
            !this.registry.active(id))
        )
          connection.socket.terminate();
        else {
          const cancelled = this.database.sqlite
            .prepare(
              "SELECT id AS jobId, attempt FROM backtest_jobs WHERE agent_id = ? AND status = 'CANCELLING'",
            )
            .all(id) as Array<{ jobId: string; attempt: number }>;
          for (const job of cancelled)
            this.send(connection, {
              type: "LEASE",
              kind: "BACKTEST",
              ...job,
              accepted: true,
              cancelRequested: true,
            });
          const preparations = this.database.sqlite
            .prepare(
              "SELECT j.id AS jobId, l.attempt FROM backtest_preparation_jobs j JOIN agent_preparation_leases l ON l.job_id = j.id WHERE l.client_id = ? AND j.status = 'RUNNING' AND j.cancel_requested = 1",
            )
            .all(id) as Array<{ jobId: string; attempt: number }>;
          for (const job of preparations)
            this.send(connection, {
              type: "LEASE",
              kind: "PREPARATION",
              ...job,
              accepted: true,
              cancelRequested: true,
            });
        }
      }
      this.wake();
    } catch (error) {
      this.logger.warn({ err: error }, "에이전트 스케줄러 주기 처리 실패");
    }
  }

  private activeLeaseCount(clientId: string): number {
    const backtests = this.database.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM backtest_jobs WHERE agent_id = ? AND status IN ('STARTING', 'RUNNING', 'CANCELLING')",
      )
      .get(clientId) as { n: number };
    const preparations = this.database.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_preparation_leases l JOIN backtest_preparation_jobs j ON j.id = l.job_id WHERE client_id = ? AND j.status = 'RUNNING'",
      )
      .get(clientId) as { n: number };
    return backtests.n + preparations.n;
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.queue.events.off("queued", this.wake);
    this.backtests.events.off("job", this.wake);
    this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.resultAbort.abort(new AgentCoordinatorStoppingError());
    const backtestsStopping = this.backtests.stop();
    for (const { socket } of this.connections.values()) socket.terminate();
    this.connections.clear();
    const primary = await Promise.allSettled([
      this.localClient?.stop() ?? Promise.resolve(),
      this.drain(this.messageOperations),
      this.drain(this.resultOperations),
      backtestsStopping,
      this.dispatching ?? Promise.resolve(),
    ]);
    // 서버 자식의 종료를 확인한 뒤에만 로컬 리스를 반환한다. 원격 리스는 만료까지 유지한다.
    if (this.localClient) this.invalidateClientLeases(LOCAL_AGENT_ID);
    const secondary = await Promise.allSettled([
      this.dataQueue.stop(),
      this.snapshots.stop(),
    ]);
    const errors = [...primary, ...secondary]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0)
      throw new AggregateError(errors, "에이전트 종료 중 일부 자원을 정리하지 못했습니다.");
  }
}
