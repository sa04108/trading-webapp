import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import Database from "better-sqlite3";
import {
  AGENT_HEARTBEAT_MS,
  AGENT_PROTOCOL_VERSION,
  AGENT_MAX_MESSAGE_BYTES,
  agentLeaseSchema,
  type AgentLease,
  type AgentMessage,
  type ServerAgentMessage,
} from "../shared/agent-protocol.js";
import {
  backtestExecutionTelemetrySchema,
  type BacktestExecutionTelemetry,
} from "../runtime/modules/backtest/application/backtest-execution-telemetry.js";
import { readRuntimeVersions } from "../runtime/shared/runtime-versions.js";
import { openDatabase } from "../runtime/shared/db/database.js";
import { backtestJobs } from "../runtime/shared/db/schema.js";
import {
  availableResources,
  processRss,
  type AgentResources,
} from "./resources.js";
import { AgentDatasetCache, durableJson } from "./dataset-cache.js";
import type { AgentSettings } from "./config.js";
import { parseWorkerDiagnostics, type WorkerDiagnostics } from "../shared/agent-diagnostics.js";
import {
  classifyWorker, diagnosticError, diagnosticSummary, emptyDiagnostics,
  inspectArtifact, inspectJobDatabase, observeWorker, redactDiagnostics,
  retainDiagnostic, pruneDiagnostics, type WorkerObservation,
} from "./worker-diagnostics.js";

type FinishMessage = Extract<AgentMessage, { type: "FINISH" | "NEEDS_DATA" }>;
export interface AgentResultUpload {
  lease: AgentLease;
  artifactPath: string;
  sha256: string;
  telemetry?: BacktestExecutionTelemetry;
}

/** 서버 내부 실행도 동일한 계산·리스·outbox를 사용하고 전송 경계만 바꾼다. */
export interface AgentRuntimeAdapter {
  runnerVersion: string;
  cache: Pick<
    AgentDatasetCache,
    "current" | "syncing" | "synchronize" | "file" | "prune" | "stop"
  >;
  connect(receive: (message: ServerAgentMessage) => void): void;
  send(message: AgentMessage): void;
  close(): void;
  upload(input: AgentResultUpload, signal: AbortSignal): Promise<number>;
  resources: typeof availableResources;
}

interface Outbox {
  lease: AgentLease;
  diagnostics?: WorkerDiagnostics;
  message?: FinishMessage;
  artifactPath?: string;
  sha256?: string;
  telemetry?: BacktestExecutionTelemetry;
}
interface Running {
  lease: AgentLease;
  child: ChildProcess;
  directory: string;
  jobPath: string;
  progress?: Extract<AgentMessage, { type: "HEARTBEAT" }>["progress"];
  preparationProgress?: Extract<
    AgentMessage,
    { type: "HEARTBEAT" }
  >["preparationProgress"];
  peakRss: number;
  budgetBytes: number;
  resourceError?: string;
  observation: WorkerObservation;
  cancellationReason?: string;
  cancellation: boolean;
  cancelPath?: "IPC" | "SIGTERM" | "SIGKILL";
  telemetry?: BacktestExecutionTelemetry;
  timers: NodeJS.Timeout[];
}

/** 연결 유지와 작업 수명은 부모가 맡고 계산은 격리된 자식 프로세스에서 수행한다. */
export class AgentClient {
  private socket: WebSocket | null = null;
  private ready = false;
  private stopping = false;
  private retry = 0;
  private lastServerContact = Date.now();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;
  private readonly running = new Map<string, Running>();
  private readonly outbox = new Map<string, Outbox>();
  private readonly unpersisted = new Set<string>();
  private readonly uploads = new Map<string, Promise<void>>();
  private readonly uploadAborts = new Map<string, AbortController>();
  private readonly finishing = new Set<Promise<void>>();
  private readonly cache: AgentRuntimeAdapter["cache"];
  private observedRss = 0;
  private profiled = false;
  private requestedBars = 0;
  private admission: AgentResources = availableResources(0, 0, false);
  private lockOwned = false;
  private updating = false;
  private runnerVersion: string | null = null;
  private lastDiagnosticsPruneAt = 0;

  constructor(
    readonly settings: AgentSettings,
    readonly directory: string,
    private readonly onUpdateRequired?: (
      runnerVersion: string,
    ) => Promise<void>,
    private readonly log: (message: string) => void = console.log,
    private readonly runtime?: AgentRuntimeAdapter,
  ) {
    fs.mkdirSync(path.join(directory, "jobs"), {
      recursive: true,
      mode: 0o700,
    });
    this.cache =
      runtime?.cache ??
      new AgentDatasetCache(path.join(directory, "datasets"), settings, (progress) => {
        this.send({ type: "DEVICE_ACTIVITY", progress });
      });
  }

  start(): void {
    this.lock();
    pruneDiagnostics(this.directory, this.log);
    this.lastDiagnosticsPruneAt = Date.now();
    this.restoreOutbox();
    this.connect();
    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      AGENT_HEARTBEAT_MS,
    );
    this.sampleTimer = setInterval(() => this.sample(), 1000);
  }

  private lock(): void {
    const file = path.join(this.directory, "agent.pid");
    if (fs.existsSync(file)) {
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive)
          throw new Error("같은 설정 경로에서 에이전트가 이미 실행 중입니다");
      }
      fs.rmSync(file);
    }
    fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
    this.lockOwned = true;
  }

  private restoreOutbox(): void {
    for (const name of fs.readdirSync(path.join(this.directory, "jobs"))) {
      if (!/^[a-zA-Z0-9_-]+-\d+$/.test(name)) continue;
      const directory = path.join(this.directory, "jobs", name);
      const file = path.join(directory, "outbox.json");
      if (fs.existsSync(file)) {
        const value = JSON.parse(fs.readFileSync(file, "utf8")) as Outbox;
        value.lease = agentLeaseSchema.parse(value.lease);
        if (value.diagnostics) value.diagnostics = parseWorkerDiagnostics(value.diagnostics);
        // 결과 경로는 기록의 외부 경로를 신뢰하지 않고 소유 작업 폴더에서 재구성한다.
        if (value.artifactPath)
          value.artifactPath = path.join(directory, "result.sqlite");
        this.outbox.set(this.key(value.lease), value);
      } else {
        // 이전 실행의 리스 토큰은 전송하지 않고, 중단 흔적만 별도로 보존한다.
        let diagnostics = emptyDiagnostics();
        try {
          const record = JSON.parse(fs.readFileSync(path.join(directory, "execution.json"), "utf8")) as { diagnostics?: unknown };
          diagnostics = parseWorkerDiagnostics(record.diagnostics) ?? diagnostics;
        } catch { /* 시작 기록이 없어도 중단 사실은 남긴다. */ }
        diagnostics.code = "AGENT_INTERRUPTED";
        diagnostics.finishedAtMs = Date.now();
        const record = { event: "agent.worker.interrupted", key: name, diagnostics };
        this.log(JSON.stringify(record));
        retainDiagnostic(this.directory, name, record, durableJson, this.log);
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }

  private connect(): void {
    if (this.stopping) return;
    if (this.runtime) {
      this.runnerVersion = this.runtime.runnerVersion;
      this.runtime.connect((message) => {
        if (this.stopping) return;
        try { this.message(message); }
        catch (error) { this.log(`로컬 계산 메시지 처리 오류: ${this.error(error)}`); }
      });
      this.send({
        type: "HELLO",
        protocolVersion: AGENT_PROTOCOL_VERSION,
        runnerVersion: this.runtime.runnerVersion,
      });
      return;
    }
    const url = new URL("/api/agents/connect", this.settings.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.settings.token}` },
      handshakeTimeout: 15_000,
      maxPayload: AGENT_MAX_MESSAGE_BYTES,
    });
    this.socket = socket;
    socket.once("open", () => {
      this.lastServerContact = Date.now();
      this.runnerVersion = readRuntimeVersions().agentVersion;
      this.send({
        type: "HELLO",
        protocolVersion: AGENT_PROTOCOL_VERSION,
        runnerVersion: this.runnerVersion,
      });
    });
    socket.on("pong", () => {
      this.lastServerContact = Date.now();
    });
    socket.on("message", (raw) => {
      this.lastServerContact = Date.now();
      try {
        this.message(JSON.parse(raw.toString()) as ServerAgentMessage);
      } catch (error) {
        this.log(`서버 메시지 처리 오류: ${this.error(error)}`);
        socket.close(4002);
      }
    });
    socket.on("error", (error) =>
      this.log(`서버 연결 재시도 예정: ${error.message}`),
    );
    socket.once("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.ready = false;
      }
      if (!this.stopping) {
        const delay =
          Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5)) *
          (0.75 + Math.random() * 0.5);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });
  }

  private send(message: AgentMessage): void {
    if (this.runtime) this.runtime.send(message);
    else if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  private message(message: ServerAgentMessage): void {
    if (message.type === "WELCOME") {
      this.ready = true;
      this.retry = 0;
      this.log("운영 서버에 연결됨 — 작업 대기");
      this.heartbeat();
    } else if (message.type === "UPDATE_REQUIRED") {
      this.ready = false;
      if (!this.updating && this.onUpdateRequired) {
        this.updating = true;
        void this.update(message.runnerVersion).catch((error: unknown) => {
          this.updating = false;
          this.log(`클라이언트 업데이트 실패: ${this.error(error)}`);
          this.socket?.close();
        });
      } else this.log("운영 서버에 맞는 클라이언트 업데이트를 기다립니다");
    } else if (message.type === "DEMAND") {
      if (
        Number.isSafeInteger(message.estimatedBars) &&
        message.estimatedBars >= 0 &&
        this.requestedBars !== message.estimatedBars
      ) {
        this.requestedBars = message.estimatedBars;
        this.capacity();
      }
    } else if (message.type === "DATASET") {
      void this.cache
        .synchronize(message.dataset)
        .then(() => {
          this.prune();
          this.capacity();
        })
        .catch((error: unknown) => {
          this.log(`데이터 동기화 재시도 예정: ${this.error(error)}`);
        });
    } else if (message.type === "JOB") {
      const lease = agentLeaseSchema.parse(message.lease);
      if (this.running.has(this.key(lease)) || this.outbox.has(this.key(lease)))
        return;
      // 로컬·원격 모두 작업 준비 실패를 동일한 outbox 경로로 보고한다.
      try {
        if (
          this.cache.current?.version !== lease.dataset.version ||
          this.cache.current.sha256 !== lease.dataset.sha256 ||
          this.cache.current.collectionVersion !== lease.dataset.collectionVersion
        ) throw new Error("준비하지 않은 데이터 버전의 작업입니다");
        this.spawn(lease);
      } catch (error) {
        const running = this.running.get(this.key(lease));
        if (running) {
          running.observation.recordError(error);
          this.cancel(running, "PROCESS_CONTROL_ERROR");
        } else this.failSetup(lease, error);
      }
    } else if (message.type === "LEASE") {
      const key = `${message.jobId}-${message.attempt}`;
      const running = this.running.get(key);
      if (running) {
        if (message.leaseExpiresAtMs)
          running.lease.leaseExpiresAtMs = message.leaseExpiresAtMs;
        if (!message.accepted || message.cancelRequested)
          this.cancel(running, message.accepted ? "SERVER_CANCEL_REQUEST" : "LEASE_REJECTED");
      }
      if (!message.accepted && this.outbox.has(key)) this.acknowledge(key);
    } else if (message.type === "ACK") {
      this.acknowledge(`${message.jobId}-${message.attempt}`);
    }
  }

  /** 로컬 배정 직전에도 현재 자원을 다시 측정한다. */
  refreshCapacity(): void {
    this.capacity();
  }

  private capacity(): void {
    if (!this.ready) return;
    this.admission = (this.runtime?.resources ?? availableResources)(
      this.running.size,
      this.observedRss,
      this.profiled,
      this.requestedBars,
    );
    const slots = this.admission.slots;
    this.send({
      type: "CAPACITY",
      slots: this.cache.syncing || this.updating ? 0 : slots,
      datasetVersion: this.cache.current?.version ?? 0,
      maxBars: this.admission.maxBars,
    });
  }

  private heartbeat(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.ping();
    if (!this.ready) return;
    for (const running of this.running.values())
      this.send({
        type: "HEARTBEAT",
        ...this.identity(running.lease),
        progress: running.progress,
        preparationProgress: running.preparationProgress,
      });
    for (const [key, entry] of this.outbox) {
      if (this.unpersisted.has(key)) this.persistOutbox(entry);
      if (entry.message) this.send(entry.message);
      else if (entry.artifactPath) {
        this.send({ type: "HEARTBEAT", ...this.identity(entry.lease) });
        if (!this.uploads.has(key)) {
          const uploading = this.upload(entry)
            .catch((error: unknown) =>
              this.log(JSON.stringify({ event: "agent.result-upload-retry", key,
                error: diagnosticError(error) })),
            )
            .finally(() => this.uploads.delete(key));
          this.uploads.set(key, uploading);
        }
      }
    }
    this.capacity();
  }

  private sample(): void {
    if (Date.now() - this.lastDiagnosticsPruneAt >= 60 * 60_000) {
      pruneDiagnostics(this.directory, this.log);
      this.lastDiagnosticsPruneAt = Date.now();
    }
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      Date.now() - this.lastServerContact > 45_000
    )
      this.socket.terminate();
    for (const running of this.running.values()) {
      if (running.observation.exited) continue;
      running.peakRss = Math.max(
        running.peakRss,
        running.child.pid ? processRss(running.child.pid) : 0,
      );
      if (running.peakRss > running.budgetBytes && !running.cancellation) {
        running.resourceError =
          "계산 프로세스가 자동 산정된 가용 메모리 예산을 초과했습니다";
        this.cancel(running, "MEMORY_BUDGET_EXCEEDED");
      }
      if (Date.now() > running.lease.leaseExpiresAtMs) this.cancel(running, "LEASE_EXPIRED");
    }
    this.capacity();
  }

  private spawn(lease: AgentLease): void {
    const key = this.key(lease);
    const directory = path.join(this.directory, "jobs", key);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    durableJson(path.join(directory, "lease.json"), lease);
    const jobPath = path.join(directory, "job.sqlite");
    const dataPath = this.cache.file(lease.dataset);
    if (lease.kind === "BACKTEST") {
      const database = openDatabase(jobPath, { dataPath, dataReadonly: true });
      try {
        database.db
          .insert(backtestJobs)
          .values({
            ...lease.payload,
            id: lease.jobId,
            status: "RUNNING",
            preparationJobId: null,
            cloneBatchId: null,
          } as typeof backtestJobs.$inferInsert)
          .run();
      } finally {
        database.close();
      }
    }
    const ts = import.meta.url.endsWith(".ts");
    const target =
      lease.kind === "PREPARATION"
        ? `../runtime/workers/preparation-child.${ts ? "ts" : "js"}`
        : `../runtime/workers/backtest-child.${ts ? "ts" : "js"}`;
    let child: ChildProcess;
    try {
      child = fork(fileURLToPath(new URL(target, import.meta.url)), [], {
        execArgv: [
          `--max-old-space-size=${this.admission.heapMb}`,
          ...(ts ? ["--import", "tsx"] : []),
        ],
        env: {
          NODE_ENV: "production",
          DATABASE_PATH: jobPath,
          BACKTEST_JOB_ID: lease.jobId,
          DATA_SNAPSHOT_PATH: dataPath,
          WORKER_MAX_BARS: String(this.admission.maxBars),
          BACKTEST_RESULT_PATH: path.join(directory, "result.sqlite"),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      this.failSetup(lease, error, "WORKER_SPAWN_FAILED");
      return;
    }
    // spawn/error는 다음 tick에 발생하므로 송신보다 먼저 모든 관측기를 설치한다.
    const timers: NodeJS.Timeout[] = [];
    const observation = observeWorker(child, () => {
      for (const timer of timers) clearTimeout(timer);
    });
    if (child.pid) {
      try {
        os.setPriority(child.pid, 10);
      } catch {
        /* 우선순위 조정 불가 시 기본값을 사용한다. */
      }
    }
    const running: Running = {
      lease,
      child,
      directory,
      jobPath,
      peakRss: 0,
      budgetBytes: this.admission.budgetBytes,
      cancellation: false,
      observation,
      timers,
    };
    this.running.set(key, running);
    this.requestedBars = 0;
    let pending: FinishMessage | undefined;
    this.recordExecution(running, { ...observation.snapshot(),
      memoryBudgetBytes: Math.max(0, Math.floor(running.budgetBytes)),
      peakRssBytes: running.peakRss }, false);
    child.on(
      "message",
      (message: {
        type: string;
        diagnosticError?: unknown;
        phase?: string;
        telemetry?: unknown;
        request?: Extract<AgentMessage, { type: "NEEDS_DATA" }>["request"];
        outcome?: string;
        result?: Record<string, unknown>;
        error?: string;
        processedBars?: number;
        totalBars?: number;
        progressLabel?: string | null;
        activity?: NonNullable<Running["progress"]>["activity"];
        progress?: Extract<
          AgentMessage,
          { type: "HEARTBEAT" }
        >["preparationProgress"];
      }) => {
        try {
          if (!message || typeof message !== "object") return;
          if (message.type === "WORKER_DIAGNOSTIC")
            observation.workerError(message.diagnosticError);
          const phase = message.activity ?? message.progress?.phase ?? message.phase;
          if (typeof phase === "string" && phase !== observation.snapshot().lastPhase) {
            observation.phase(phase);
            this.recordExecution(running, { ...observation.snapshot(),
              memoryBudgetBytes: Math.max(0, Math.floor(running.budgetBytes)),
              peakRssBytes: running.peakRss }, false);
          }
          if (message.type === "telemetry") {
            const parsed = backtestExecutionTelemetrySchema.safeParse(
              message.telemetry,
            );
            if (parsed.success) running.telemetry = parsed.data;
          } else if (
            message.type === "progress" &&
            message.processedBars !== undefined &&
            message.totalBars !== undefined
          ) {
            const activityChanged =
              message.activity !== undefined &&
              message.activity !== running.progress?.activity;
            running.progress = {
              processedBars: message.processedBars,
              totalBars: message.totalBars,
              progressLabel: message.progressLabel ?? null,
              ...(message.activity ? { activity: message.activity } : {}),
            };
            if (activityChanged) this.heartbeat();
          } else if (message.type === "PROGRESS" && message.progress) {
            const phaseChanged =
              message.progress.phase !== running.preparationProgress?.phase;
            running.preparationProgress = message.progress;
            if (phaseChanged) this.heartbeat();
          } else if (message.type === "NEEDS_DATA" && message.request)
            pending = {
              type: "NEEDS_DATA",
              ...this.identity(lease),
              request: message.request,
            };
          else if (message.type === "FINISH")
            pending = {
              type: "FINISH",
              ...this.identity(lease),
              outcome:
                message.outcome === "COMPLETED"
                  ? "COMPLETED"
                  : message.outcome === "CANCELLED"
                    ? "CANCELLED"
                    : "FAILED",
              result: message.result,
              ...(message.error ? { error: message.error.slice(0, 2000) } : {}),
            };
        } catch (error) {
          observation.recordError(error);
          this.cancel(running, "PROCESS_CONTROL_ERROR");
        }
      },
    );
    const completion = observation.closed
      .then(() => this.finished(running, pending))
      .catch((error: unknown) => {
        const diagnostics = this.inspectExecution(running);
        diagnostics.code = "FINALIZATION_FAILED";
        diagnostics.processErrors = [...diagnostics.processErrors, diagnosticError(error)].slice(0, 4);
        const safe = this.recordExecution(running, diagnostics, true);
        if (!this.stopping && !this.updating)
          this.queueOutbox({ lease, message: {
            type: "FINISH", ...this.identity(lease), outcome: "FAILED",
            error: diagnosticSummary(safe), result: { diagnostics: safe },
          } });
      });
    this.finishing.add(completion);
    void completion.finally(() => this.finishing.delete(completion));
    child.send({ lease, jobPath, dataPath }, (error) => {
      if (error) {
        observation.recordError(error);
        this.cancel(running, "PROCESS_CONTROL_ERROR");
      }
    });
    this.log(`${lease.kind} 작업 시작: ${lease.jobId}`);
  }

  private inspectExecution(running: Running): WorkerDiagnostics {
    const diagnostics = running.observation.snapshot();
    diagnostics.jobDb = inspectJobDatabase(running.jobPath, running.lease.kind,
      running.lease.jobId, (file) => new Database(file, { readonly: true, fileMustExist: true }));
    diagnostics.artifact = inspectArtifact(path.join(running.directory, "result.sqlite"));
    diagnostics.peakRssBytes = running.peakRss;
    diagnostics.memoryBudgetBytes = Math.max(0, Math.floor(running.budgetBytes));
    diagnostics.cancellationReason = running.cancellationReason ?? null;
    diagnostics.cancelPath = running.cancelPath ?? null;
    return diagnostics;
  }

  private recordExecution(
    running: Pick<Running, "lease" | "directory">,
    diagnostics: WorkerDiagnostics,
    terminal: boolean,
  ): WorkerDiagnostics {
    const safe = redactDiagnostics(diagnostics, [this.settings.token, running.lease.leaseToken]);
    const record = {
      event: terminal ? "agent.worker.finished" : "agent.worker.stage",
      kind: running.lease.kind, jobId: running.lease.jobId,
      attempt: running.lease.attempt, datasetVersion: running.lease.dataset.version,
      executionMode: this.runtime ? "local" : "remote",
      runnerVersion: this.runnerVersion, nodeVersion: process.version,
      platform: process.platform, arch: process.arch, diagnostics: safe,
    };
    // 일반 단계 로그에는 출력 원문 대신 단계와 시각만 남긴다.
    if (terminal) this.log(JSON.stringify(record));
    else this.log(JSON.stringify({ ...record, diagnostics: {
      pid: safe.pid, lastPhase: safe.lastPhase, lastMessageAtMs: safe.lastMessageAtMs,
    } }));
    if (terminal) retainDiagnostic(this.directory, this.key(running.lease), record, durableJson, this.log);
    try {
      fs.mkdirSync(running.directory, { recursive: true, mode: 0o700 });
      durableJson(path.join(running.directory, "execution.json"), record);
    }
    catch (error) { this.log(`작업 진단 저장 실패: ${this.error(error)}`); }
    return safe;
  }

  private failSetup(
    lease: AgentLease, error: unknown,
    code: "JOB_SETUP_FAILED" | "WORKER_SPAWN_FAILED" = "JOB_SETUP_FAILED",
  ): void {
    const directory = path.join(this.directory, "jobs", this.key(lease));
    const diagnostics = emptyDiagnostics();
    diagnostics.code = code;
    diagnostics.processErrors.push(diagnosticError(error));
    diagnostics.jobDb = inspectJobDatabase(path.join(directory, "job.sqlite"), lease.kind,
      lease.jobId, (file) => new Database(file, { readonly: true, fileMustExist: true }));
    diagnostics.artifact = inspectArtifact(path.join(directory, "result.sqlite"));
    const safe = this.recordExecution({ lease, directory }, diagnostics, true);
    this.queueOutbox({ lease, message: {
      type: "FINISH", ...this.identity(lease), outcome: "FAILED",
      error: diagnosticSummary(safe), result: { diagnostics: safe },
    } });
  }

  /** 디스크 실패 시에도 메모리 재전송은 유지한다. 다음 heartbeat에서 영속화를 재시도한다. */
  private persistOutbox(entry: Outbox): void {
    const key = this.key(entry.lease);
    try {
      const directory = path.join(this.directory, "jobs", key);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      durableJson(path.join(directory, "outbox.json"), entry);
      this.unpersisted.delete(key);
    } catch (error) {
      if (!this.unpersisted.has(key))
        this.log(JSON.stringify({ event: "agent.outbox-storage-failed", key, error: diagnosticError(error) }));
      this.unpersisted.add(key);
    }
  }

  private queueOutbox(entry: Outbox): void {
    this.outbox.set(this.key(entry.lease), entry);
    this.persistOutbox(entry);
    this.heartbeat();
  }

  private async finished(
    running: Running,
    pending: FinishMessage | undefined,
  ): Promise<void> {
    const key = this.key(running.lease);
    for (const timer of running.timers) clearTimeout(timer);
    this.running.delete(key);
    this.observedRss = Math.max(this.observedRss, running.peakRss);
    this.profiled = true;
    const diagnostics = this.inspectExecution(running);
    diagnostics.code = classifyWorker({
      kind: running.lease.kind, diagnostics, pendingType: pending?.type,
      pendingOutcome: pending?.type === "FINISH" ? pending.outcome : undefined,
      resourceError: running.resourceError,
      cancellation: running.cancellation,
    });
    if (this.stopping || this.updating) {
      diagnostics.code = "AGENT_INTERRUPTED";
      this.recordExecution(running, diagnostics, true);
      return;
    }
    let entry: Outbox = { lease: running.lease, telemetry: running.telemetry };
    if (diagnostics.code === "COMPLETED" && running.lease.kind === "BACKTEST") {
      const artifactPath = path.join(running.directory, "result.sqlite");
      try {
        const hash = createHash("sha256");
        for await (const chunk of fs.createReadStream(artifactPath)) hash.update(chunk);
        entry = { ...entry, artifactPath, sha256: hash.digest("hex") };
      } catch (error) {
        diagnostics.code = "RESULT_ARTIFACT_READ_FAILED";
        diagnostics.artifact = { ...diagnostics.artifact, state: "READ_FAILED", error: diagnosticError(error) };
      }
    }
    const safe = this.recordExecution(running, diagnostics, true);
    entry.diagnostics = safe;
    if (safe.code === "NEEDS_DATA" && pending?.type === "NEEDS_DATA") entry.message = pending;
    else if (safe.code === "COMPLETED" && running.lease.kind === "PREPARATION" && pending?.type === "FINISH")
      entry.message = { ...pending, result: { ...pending.result, diagnostics: safe } };
    else if (!entry.artifactPath) {
      const reported = running.resourceError ?? (pending?.type === "FINISH" ? pending.error : undefined);
      const summary = diagnosticSummary(safe, reported);
      entry.message = {
        type: "FINISH", ...this.identity(running.lease),
        outcome: safe.code === "CANCELLED" ? "CANCELLED" : "FAILED",
        error: redactDiagnostics({ ...safe, stderr: { ...safe.stderr, text: summary } },
          [this.settings.token, running.lease.leaseToken]).stderr.text.slice(0, 2000),
        result: { telemetry: running.telemetry, cancelPath: running.cancelPath, diagnostics: safe },
      };
    }
    this.queueOutbox(entry);
  }

  private async upload(entry: Outbox): Promise<void> {
    const key = this.key(entry.lease);
    const abort = new AbortController();
    this.uploadAborts.set(key, abort);
    try {
      const status = this.runtime
        ? await this.runtime.upload(
            {
              lease: entry.lease,
              artifactPath: entry.artifactPath!,
              sha256: entry.sha256!,
              telemetry: entry.telemetry,
            },
            abort.signal,
          )
        : await this.uploadRemote(entry, abort.signal);
      if ((status >= 200 && status < 300) || status === 409)
        this.acknowledge(this.key(entry.lease));
      else if ([400, 413, 415, 422].includes(status)) {
        const diagnostics = entry.diagnostics ?? emptyDiagnostics();
        diagnostics.code = "RESULT_UPLOAD_REJECTED";
        diagnostics.deliveryError = diagnosticError(new Error(`서버가 결과 파일을 거부했습니다 (HTTP ${status})`));
        const safe = this.recordExecution({ lease: entry.lease,
          directory: path.join(this.directory, "jobs", key) }, diagnostics, true);
        entry.diagnostics = safe;
        entry.message = {
          type: "FINISH",
          ...this.identity(entry.lease),
          outcome: "FAILED",
          error: diagnosticSummary(safe),
          result: { diagnostics: safe, telemetry: entry.telemetry },
        };
        this.persistOutbox(entry);
        this.send(entry.message);
      } else throw new Error(`HTTP ${status}`);
    } finally {
      this.uploadAborts.delete(key);
    }
  }

  private async uploadRemote(
    entry: Outbox,
    signal: AbortSignal,
  ): Promise<number> {
    const response = await fetch(
      `${this.settings.serverUrl}/api/agents/jobs/${entry.lease.jobId}/result`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
        headers: {
          authorization: `Bearer ${this.settings.token}`,
          "content-type":
            "application/vnd.quant-platform.backtest-result+sqlite",
          "content-length": String(fs.statSync(entry.artifactPath!).size),
          "x-agent-attempt": String(entry.lease.attempt),
          "x-agent-lease-token": entry.lease.leaseToken,
          "x-content-sha256": entry.sha256!,
          ...(entry.telemetry
            ? { "x-agent-telemetry": JSON.stringify(entry.telemetry) }
            : {}),
        },
        body: fs.createReadStream(
          entry.artifactPath!,
        ) as unknown as RequestInit["body"],
        duplex: "half",
      } as RequestInit,
    );
    await response.arrayBuffer();
    return response.status;
  }

  private acknowledge(key: string): void {
    if (!this.outbox.delete(key)) return;
    this.unpersisted.delete(key);
    fs.rmSync(path.join(this.directory, "jobs", key), {
      recursive: true,
      force: true,
    });
    this.prune();
    this.capacity();
  }
  private prune(): void {
    this.cache.prune(
      new Set(
        [...this.running.values()].map(({ lease }) =>
          this.cache.file(lease.dataset),
        ),
      ),
    );
  }
  private key(lease: AgentLease): string {
    return `${lease.jobId}-${lease.attempt}`;
  }
  private identity(
    lease: AgentLease,
  ): Pick<AgentLease, "kind" | "jobId" | "attempt" | "leaseToken"> {
    return {
      kind: lease.kind,
      jobId: lease.jobId,
      attempt: lease.attempt,
      leaseToken: lease.leaseToken,
    };
  }
  private error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  private cancel(running: Running, reason = "AGENT_SHUTDOWN"): void {
    if (running.cancellation || running.observation.exited) return;
    running.cancellation = true;
    running.cancellationReason = reason;
    running.cancelPath = "IPC";
    if (running.child.connected) {
      try {
        running.child.send({ type: "cancel" }, (error) => {
          if (error) running.observation.recordError(error);
        });
      } catch (error) { running.observation.recordError(error); }
    }
    running.timers.push(
      setTimeout(() => {
        running.cancelPath = "SIGTERM";
        running.child.kill("SIGTERM");
      }, 2000),
      setTimeout(() => {
        running.cancelPath = "SIGKILL";
        running.child.kill("SIGKILL");
      }, 5000),
    );
  }

  private async cancelChildren(): Promise<void> {
    for (const running of this.running.values())
      this.cancel(running, this.updating ? "AGENT_UPDATE" : "AGENT_SHUTDOWN");
    // spawn 실패로 exit가 없어도 close에 연결된 completion은 반드시 정리된다.
    await Promise.all([...this.finishing]);
  }

  private async update(version: string): Promise<void> {
    // UPDATE_REQUIRED는 서버가 이전 리스를 폐기한 뒤 보내는 응답이다.
    for (const abort of this.uploadAborts.values()) abort.abort();
    await this.cancelChildren();
    await Promise.all([...this.uploads.values()]);
    for (const key of [...this.outbox.keys()]) this.acknowledge(key);
    await this.onUpdateRequired!(version);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.socket?.terminate();
    this.runtime?.close();
    for (const abort of this.uploadAborts.values()) abort.abort();
    await this.cancelChildren();
    await Promise.all([...this.uploads.values()]);
    await this.cache.stop();
    if (this.lockOwned)
      fs.rmSync(path.join(this.directory, "agent.pid"), { force: true });
  }
}
