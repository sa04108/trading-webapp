import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { AgentClient } from "../../../../agent/client.js";
import { availableServerResources } from "../../../../agent/resources.js";
import { BacktestResultArtifactRejectedError } from "../../../../runtime/modules/backtest/application/backtest-result-artifact.js";
import { InvalidBacktestResultArtifactError } from "../../backtest/infrastructure/sqlite-backtest-result-artifact-importer.js";
import { backtestExecutionTelemetrySchema } from "../../../../runtime/modules/backtest/application/backtest-execution-telemetry.js";
import type { WebSocket } from "ws";
import { MAX_BACKTEST_BARS } from "../../../shared/backtest-limits.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { Logger } from "../../../shared/logger.js";
import type { BacktestLeaseService } from "../../backtest/application/backtest-lease-service.js";
import type { JobQueue } from "../../backtest/application/job-queue.js";
import {
  LOCAL_AGENT_ID,
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
      this.preparations.notifyQueued();
      return;
    }
    const identity = {
      jobId: message.jobId,
      attempt: message.attempt,
      leaseToken: message.leaseToken,
    };
    if (message.type === "HEARTBEAT") {
      if (message.kind === "PREPARATION") {
        this.send(connection, {
          type: "LEASE",
          kind: message.kind,
          ...identity,
          ...this.preparations.heartbeat(
            clientId,
            identity,
            message.preparationProgress,
          ),
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
    if (message.type === "NEEDS_DATA") {
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
    if (job.status === "WAITING_DATA") {
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
      const activities = {
        MARKET_DATA: "CHECKING_INPUT",
        RESOLVING_STAGES: "RESOLVING_UNIVERSE",
        VALIDATING_RESULT: "VALIDATING_INPUT",
        SYNCING_FACTS: "CHECKING_INPUT",
        FINALIZING: "SAVING_PREVIEW",
      } as const;
      return {
        activity: activities[job.phase], detail: null, actorKind,
        actorId: lease?.client_id ?? null,
        actorName: actorKind === "SERVER_AGENT" ? "운영 서버 내부 agent" : (lease?.name ?? "원격 agent"),
        unit: job.totalSymbols > 0 ? "SYMBOLS" : null,
        completed: job.totalSymbols > 0 ? job.doneSymbols : null,
        total: job.totalSymbols > 0 ? job.totalSymbols : null,
        currentItem: null, attempt: lease?.attempt ?? null, retryCount: 0,
        startedAtMs: times?.created_at_ms ?? activityAt, lastProgressAtMs: activityAt,
        lastReceivedAtMs: lease?.last_received_at_ms ?? null, nextResumeAtMs: null,
      };
    }
    if (job.status !== "QUEUED") return null;
    const publishing = this.snapshots.publishProgress();
    if (publishing)
      return {
        activity: publishing.activity, detail: null, actorKind: "SERVER", actorId: null,
        actorName: "운영 서버", unit: null, completed: null, total: null,
        currentItem: null, attempt: null, retryCount: 0,
        startedAtMs: publishing.startedAtMs, lastProgressAtMs: publishing.updatedAtMs,
        lastReceivedAtMs: publishing.updatedAtMs, nextResumeAtMs: null,
      };
    const syncing = [...this.connections.entries()]
      .map(([id, connection]) => ({ id, progress: connection.deviceProgress }))
      .find(({ progress }) => progress !== undefined);
    if (syncing?.progress) {
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
    const ready = [...this.connections.values()].filter((connection) => connection.ready).length;
    const free = [...this.connections.entries()].some(([id, connection]) => this.available(id, connection));
    return {
      activity: "WAITING_FOR_EXECUTOR",
      detail: ready === 0 ? "연결된 원격 agent가 없습니다" : free ? "입력 동기화 또는 작업 배정 중" : "연결된 agent의 계산 슬롯이 사용 중입니다",
      actorKind: "SERVER", actorId: null, actorName: "운영 서버 배정기",
      unit: null, completed: null, total: null, currentItem: null,
      attempt: null, retryCount: 0, startedAtMs: activityAt,
      lastProgressAtMs: null, lastReceivedAtMs: activityAt, nextResumeAtMs: null,
    };
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
    )
      return;
    const dataset = await this.snapshots.ensureLatest();
    if (this.stopped) return;
    // 게시를 기다리는 동안 연결된 장치까지 다시 확인한 뒤 서버의 계산 슬롯을 사용한다.
    for (const [id, connection] of this.connections)
      this.assign(id, connection, dataset);
    if (this.localClient && this.localConnection) {
      this.refreshLocalCapacity();
      this.assign(LOCAL_AGENT_ID, this.localConnection, dataset);
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

  private assign(
    clientId: string,
    connection: Connection,
    dataset: DatasetManifest,
  ): void {
    if (!this.available(clientId, connection) || this.stopped) return;
    if (connection.datasetVersion !== dataset.version) {
      this.send(connection, { type: "DATASET", dataset });
      return;
    }
    let active = this.activeLeaseCount(clientId);
    while (connection.slots > active) {
      let lease: AgentLease | null;
      const claim = this.backtests.claim(
        clientId,
        this.executionVersion,
        connection.maxBars,
      );
      if (claim.status === "CLAIMED") {
        const job = claim.lease.job;
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
          payload: { ...job, preparationJobId: null },
        };
      } else lease = this.preparations.claim(clientId, dataset);
      if (!lease) {
        const waiting = this.database.sqlite
          .prepare(
            "SELECT estimated_bars AS bars FROM backtest_jobs WHERE status = 'QUEUED' ORDER BY created_at_ms LIMIT 1",
          )
          .get() as { bars: number } | undefined;
        if (waiting && waiting.bars > connection.maxBars)
          this.send(connection, {
            type: "DEMAND",
            estimatedBars: waiting.bars,
          });
        break;
      }
      active += 1;
      this.send(connection, { type: "JOB", lease });
    }
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
