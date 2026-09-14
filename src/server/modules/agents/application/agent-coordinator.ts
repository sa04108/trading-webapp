import path from 'node:path';
import { AgentClient } from '../../../../agent/client.js';
import { availableServerResources } from '../../../../agent/resources.js';
import { BacktestResultArtifactRejectedError } from '../../backtest/application/backtest-result-artifact.js';
import { InvalidBacktestResultArtifactError } from '../../backtest/infrastructure/sqlite-backtest-result-artifact-importer.js';
import { backtestExecutionTelemetrySchema } from '../../backtest/application/backtest-execution-telemetry.js';
import type { WebSocket } from 'ws';
import { MAX_BACKTEST_BARS } from '../../../shared/backtest-limits.js';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import type { Logger } from '../../../shared/logger.js';
import type { BacktestLeaseService } from '../../backtest/application/backtest-lease-service.js';
import type { JobQueue } from '../../backtest/application/job-queue.js';
import { LOCAL_AGENT_ID, agentMessageSchema, type AgentMessage, type AgentLease, type ServerAgentMessage, type DatasetManifest } from '../../../../shared/agent-protocol.js';
import type { AgentRegistry } from './agent-registry.js';
import type { DatasetSnapshots } from './dataset-snapshots.js';
import type { AgentPreparationQueue } from './agent-preparation-queue.js';
import type { AgentDataQueue } from './agent-data-queue.js';

interface Connection { socket: { readonly readyState: number; send(data: string): void; close(code?: number, reason?: string): void; terminate(): void }; ready: boolean; slots: number; maxBars: number; datasetVersion: number; lastMessageAt: number }

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
  ) {
    this.queue.events.on('queued', this.wake);
    this.backtests.events.on('job', this.wake);
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
    if (this.stopped) { socket.close(1012, 'server stopping'); return; }
    this.connections.get(clientId)?.socket.close(4001, 'connection replaced');
    const connection: Connection = { socket, ready: false, slots: 0, maxBars: 0, datasetVersion: 0, lastMessageAt: Date.now() };
    this.connections.set(clientId, connection);
    // 비동기 DB 게시 전에 수신기를 등록해야 HELLO가 유실되지 않는다.
    let tail = Promise.resolve();
    socket.on('message', (data, binary) => {
      tail = tail.then(async () => {
        if (this.connections.get(clientId) !== connection) return;
        if (binary || !this.registry.active(clientId)) { socket.close(4003, 'unauthorized'); return; }
        const message = agentMessageSchema.parse(JSON.parse(data.toString()));
        connection.lastMessageAt = Date.now();
        this.registry.touch(clientId);
        await this.message(clientId, connection, message);
      }).catch((error: unknown) => {
        this.logger.warn({ err: error, clientId }, '에이전트 메시지 처리 실패');
        socket.close(4002, 'invalid message or state');
      });
    });
    socket.on('error', (error) => this.logger.debug({ err: error, clientId }, '에이전트 연결 오류'));
    socket.once('close', () => {
      if (this.connections.get(clientId) === connection) this.connections.delete(clientId);
      this.wake();
    });
  }

  private send(connection: Connection, message: ServerAgentMessage): void {
    if (connection.socket.readyState === 1) connection.socket.send(JSON.stringify(message));
  }

  private async message(clientId: string, connection: Connection, message: AgentMessage): Promise<void> {
    if (message.type === 'HELLO') {
      if (message.runnerVersion !== this.runnerVersion) {
        connection.ready = false;
        connection.slots = 0;
        this.invalidateClientLeases(clientId);
        this.send(connection, { type: 'UPDATE_REQUIRED', runnerVersion: this.runnerVersion });
        return;
      }
      connection.ready = true;
      this.send(connection, { type: 'WELCOME', runnerVersion: this.runnerVersion });
      if (clientId === LOCAL_AGENT_ID) { this.wake(); return; }
      const dataset = await this.snapshots.ensureLatest();
      this.send(connection, { type: 'DATASET', dataset });
      return;
    }
    if (!connection.ready) throw new Error('HELLO가 필요합니다');
    if (message.type === 'CAPACITY') {
      connection.slots = message.slots;
      connection.maxBars = message.maxBars;
      connection.datasetVersion = message.datasetVersion;
      if (!this.refreshingLocal || clientId !== LOCAL_AGENT_ID) this.wake();
      return;
    }
    const identity = { jobId: message.jobId, attempt: message.attempt, leaseToken: message.leaseToken };
    if (message.type === 'HEARTBEAT') {
      if (message.kind === 'PREPARATION') {
        this.send(connection, { type: 'LEASE', kind: message.kind, ...identity, ...this.preparations.heartbeat(clientId, identity, message.preparationProgress) });
      } else {
        if (!this.ownsBacktest(clientId, message.jobId)) {
          this.send(connection, { type: 'LEASE', kind: message.kind, ...identity, accepted: false, cancelRequested: false });
          return;
        }
        const result = this.backtests.heartbeat({ ...identity, ...message.progress });
        this.send(connection, { type: 'LEASE', kind: message.kind, ...identity, accepted: result.status === 'ACCEPTED', cancelRequested: result.status === 'ACCEPTED' && result.cancelRequested,
          ...(result.status === 'ACCEPTED' ? { leaseExpiresAtMs: result.leaseExpiresAtMs } : {}) });
      }
      return;
    }
    let accepted = false;
    if (message.type === 'NEEDS_DATA') {
      if (message.kind === 'PREPARATION') {
        try {
          accepted = this.preparations.waitForData(clientId, identity, () => {
            this.dataQueue.request(message.kind, message.jobId, this.preparations.datasetVersion(message.jobId)!, message.request);
          });
        } catch (error) {
          accepted = this.preparations.finish(clientId, identity, 'FAILED', null, 0, error instanceof Error ? error.message : String(error));
        }
      }
    } else if (message.kind === 'PREPARATION') {
      const version = this.preparations.datasetVersion(message.jobId);
      const dataset = version === null ? null : this.snapshots.get(version);
      if (dataset) accepted = this.preparations.finish(clientId, identity, message.outcome, message.result, dataset.sourceRevision, message.error);
    } else if (this.ownsBacktest(clientId, message.jobId) && message.outcome !== 'COMPLETED') {
      const telemetry = backtestExecutionTelemetrySchema.safeParse(message.result?.telemetry);
      const cancelPath = message.result?.cancelPath;
      accepted = this.backtests.finish({ ...identity, outcome: message.outcome, error: message.error,
        ...(telemetry.success ? { telemetry: telemetry.data } : {}),
        ...(['IPC', 'SIGTERM', 'SIGKILL'].includes(String(cancelPath)) ? { cancelPath: cancelPath as 'IPC' | 'SIGTERM' | 'SIGKILL' } : {}) }) === 'ACCEPTED';
    }
    this.send(connection, { type: 'ACK', kind: message.kind, jobId: message.jobId, attempt: message.attempt, accepted });
  }

  /** 버전 변경 시 이전 토큰을 먼저 폐기하고 재배정한다. 늦은 결과는 반영하지 않는다. */
  invalidateClientLeases(clientId: string): void {
    const preparations = this.database.sqlite.prepare("SELECT j.id FROM backtest_preparation_jobs j JOIN agent_preparation_leases l ON l.job_id = j.id WHERE client_id = ? AND j.status = 'RUNNING'").all(clientId) as Array<{ id: string }>;
    const backtests = this.database.sqlite.prepare("SELECT id FROM backtest_jobs WHERE agent_id = ? AND status IN ('STARTING', 'RUNNING', 'CANCELLING')").all(clientId) as Array<{ id: string }>;
    this.database.sqlite.transaction(() => {
      for (const { id } of preparations) {
        this.database.sqlite.prepare("UPDATE backtest_preparation_jobs SET status = CASE WHEN cancel_requested = 1 THEN 'CANCELLED' ELSE 'QUEUED' END, updated_at_ms = ? WHERE id = ?").run(Date.now(), id);
        this.database.sqlite.prepare('UPDATE agent_preparation_leases SET lease_token_hash = NULL, lease_expires_at_ms = NULL WHERE job_id = ?').run(id);
      }
      this.database.sqlite.prepare("UPDATE backtest_jobs SET status = CASE WHEN status = 'CANCELLING' THEN 'CANCELLED' ELSE 'QUEUED' END, agent_id = NULL, lease_token_hash = NULL, lease_expires_at_ms = NULL WHERE agent_id = ? AND status IN ('STARTING', 'RUNNING', 'CANCELLING')").run(clientId);
    })();
    for (const { id } of preparations) this.preparations.resume(id);
    for (const { id } of backtests) this.backtests.events.emit('job', { jobId: id, kind: 'status' });
  }

  maxBacktestBars(): number {
    const capacities = [...this.connections.values(), ...(this.localConnection ? [this.localConnection] : [])].filter((c) => c.ready && c.socket.readyState === 1 && c.maxBars > 0).map((c) => c.maxBars);
    return Math.max(MAX_BACKTEST_BARS, ...capacities);
  }

  ownsBacktest(clientId: string, jobId: string): boolean { return this.queue.getJob(jobId)?.agentId === clientId; }

  /** 큐 등록·슬롯 반환·재연결은 주기 타이머를 기다리지 않고 배정을 깨운다. */
  readonly wake = (): void => {
    if (this.stopped) return;
    this.dispatchRequested = true;
    if (this.dispatching) return;
    this.dispatching = Promise.resolve().then(async () => {
      while (this.dispatchRequested && !this.stopped) {
        this.dispatchRequested = false;
        await this.dispatch();
      }
    }).catch((error: unknown) => this.logger.warn({ err: error }, '계산 작업 배정 실패'))
      .finally(() => { this.dispatching = null; if (this.dispatchRequested && !this.stopped) this.wake(); });
  };

  private hasQueuedWork(): boolean {
    return !!this.database.sqlite.prepare("SELECT 1 FROM backtest_jobs WHERE status = 'QUEUED' UNION ALL SELECT 1 FROM backtest_preparation_jobs WHERE status = 'QUEUED' AND cancel_requested = 0 LIMIT 1").get();
  }

  private available(clientId: string, connection: Connection): boolean {
    return connection.ready && connection.socket.readyState === 1 && connection.slots > this.activeLeaseCount(clientId)
      && (clientId === LOCAL_AGENT_ID || Date.now() - connection.lastMessageAt <= 60_000 && this.registry.active(clientId));
  }

  private async dispatch(): Promise<void> {
    if (!this.hasQueuedWork()) return;
    this.refreshLocalCapacity();
    if (![...this.connections].some(([id, connection]) => this.available(id, connection))
      && !(this.localConnection && this.available(LOCAL_AGENT_ID, this.localConnection))) return;
    const dataset = await this.snapshots.ensureLatest();
    if (this.stopped) return;
    // 게시를 기다리는 동안 연결된 장치까지 다시 확인한 뒤 서버의 계산 슬롯을 사용한다.
    for (const [id, connection] of this.connections) this.assign(id, connection, dataset);
    if (this.localClient && this.localConnection) {
      this.refreshLocalCapacity();
      this.assign(LOCAL_AGENT_ID, this.localConnection, dataset);
    }
  }

  private refreshLocalCapacity(): void {
    this.refreshingLocal = true;
    try { this.localClient?.refreshCapacity(); } finally { this.refreshingLocal = false; }
  }

  private assign(clientId: string, connection: Connection, dataset: DatasetManifest): void {
    if (!this.available(clientId, connection) || this.stopped) return;
    if (connection.datasetVersion !== dataset.version) { this.send(connection, { type: 'DATASET', dataset }); return; }
    let active = this.activeLeaseCount(clientId);
    while (connection.slots > active) {
      let lease: AgentLease | null;
      const claim = this.backtests.claim(clientId, this.runnerVersion, connection.maxBars);
      if (claim.status === 'CLAIMED') {
        const job = claim.lease.job;
        this.database.sqlite.prepare('INSERT INTO agent_backtest_datasets (job_id, dataset_version) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET dataset_version = excluded.dataset_version').run(job.id, dataset.version);
        lease = { kind: 'BACKTEST', jobId: job.id, attempt: claim.lease.attempt, leaseToken: claim.lease.leaseToken, leaseExpiresAtMs: claim.lease.leaseExpiresAtMs, dataset, payload: { ...job, preparationJobId: null } };
      } else lease = this.preparations.claim(clientId, dataset);
      if (!lease) {
        const waiting = this.database.sqlite.prepare("SELECT estimated_bars AS bars FROM backtest_jobs WHERE status = 'QUEUED' ORDER BY created_at_ms LIMIT 1").get() as { bars: number } | undefined;
        if (waiting && waiting.bars > connection.maxBars) this.send(connection, { type: 'DEMAND', estimatedBars: waiting.bars });
        break;
      }
      active += 1;
      this.send(connection, { type: 'JOB', lease });
    }
  }

  private startLocal(): void {
    let receive: (message: ServerAgentMessage) => void = () => undefined;
    let open = true;
    let tail = Promise.resolve();
    const connection: Connection = {
      socket: {
        get readyState() { return open ? 1 : 3; },
        send: (data) => queueMicrotask(() => { if (open) receive(JSON.parse(data) as ServerAgentMessage); }),
        close: () => { open = false; },
        terminate: () => { open = false; },
      },
      ready: false, slots: 0, maxBars: 0, datasetVersion: 0, lastMessageAt: Date.now(),
    };
    this.localConnection = connection;
    const cache = {
      current: null as DatasetManifest | null,
      syncing: false,
      synchronize: async (manifest: DatasetManifest) => { cache.current = manifest; },
      file: (manifest: DatasetManifest) => this.snapshots.file(manifest),
      // 게시 파일 보존은 중앙 스케줄러가 원격·로컬 리스를 함께 보고 결정한다.
      prune: () => undefined,
      stop: async () => undefined,
    };
    this.localClient = new AgentClient({ serverUrl: 'http://localhost', token: '' },
      path.join(path.dirname(this.database.dataPath), 'server-agent'), undefined,
      (message) => this.logger.info({ module: 'local-agent' }, message), {
        runnerVersion: this.runnerVersion, cache, resources: availableServerResources,
        connect: (listener) => { receive = listener; },
        close: () => connection.socket.terminate(),
        send: (message) => {
          if (!open || this.stopped) return;
          // 배정 직전 자원 측정은 같은 호출 안에서 반영하고 나머지 메시지는 순서대로 처리한다.
          if (message.type === 'CAPACITY') void this.message(LOCAL_AGENT_ID, connection, message);
          else tail = tail.then(() => this.stopped ? undefined : this.message(LOCAL_AGENT_ID, connection, message))
            .catch((error: unknown) => this.logger.warn({ err: error }, '로컬 계산 메시지 처리 실패'));
        },
        upload: async (input, signal) => {
          signal.throwIfAborted();
          if (!this.ownsBacktest(LOCAL_AGENT_ID, input.lease.jobId)) return 409;
          const identity = { jobId: input.lease.jobId, attempt: input.lease.attempt, leaseToken: input.lease.leaseToken, checksum: input.sha256 };
          const reserved = this.backtests.reserveResultTransfer(identity);
          if (reserved.status === 'IDEMPOTENT') return 200;
          if (reserved.status === 'STALE_LEASE' || reserved.cancelRequested) return 409;
          try {
            const status = await this.backtests.complete({ ...identity, artifactPath: input.artifactPath, telemetry: input.telemetry });
            return status === 'ACCEPTED' || status === 'IDEMPOTENT' ? 200 : 409;
          } catch (error) {
            if (error instanceof BacktestResultArtifactRejectedError || error instanceof InvalidBacktestResultArtifactError) return 422;
            throw error;
          }
        },
      });
    this.localClient.start();
  }

  private tick(): void {
    if (this.stopped) return;
    try {
      this.preparations.sweep();
      this.dataQueue.tick();
      if (Date.now() - this.lastPrunedAt > 60_000) {
        const rows = this.database.sqlite.prepare("SELECT dataset_version AS version FROM agent_preparation_leases l JOIN backtest_preparation_jobs j ON j.id = l.job_id WHERE j.status = 'RUNNING' UNION SELECT dataset_version FROM agent_backtest_datasets d JOIN backtest_jobs j ON j.id = d.job_id WHERE j.status IN ('STARTING', 'RUNNING', 'CANCELLING')").all() as Array<{ version: number }>;
        this.snapshots.prune(new Set(rows.map((row) => row.version)));
        this.lastPrunedAt = Date.now();
      }
      const peers = [...this.connections, ...(this.localConnection ? [[LOCAL_AGENT_ID, this.localConnection] as const] : [])];
      for (const [id, connection] of peers) {
        if (id !== LOCAL_AGENT_ID && (Date.now() - connection.lastMessageAt > 60_000 || !this.registry.active(id))) connection.socket.terminate();
        else {
          const cancelled = this.database.sqlite.prepare("SELECT id AS jobId, attempt FROM backtest_jobs WHERE agent_id = ? AND status = 'CANCELLING'").all(id) as Array<{ jobId: string; attempt: number }>;
          for (const job of cancelled) this.send(connection, { type: 'LEASE', kind: 'BACKTEST', ...job, accepted: true, cancelRequested: true });
          const preparations = this.database.sqlite.prepare("SELECT j.id AS jobId, l.attempt FROM backtest_preparation_jobs j JOIN agent_preparation_leases l ON l.job_id = j.id WHERE l.client_id = ? AND j.status = 'RUNNING' AND j.cancel_requested = 1").all(id) as Array<{ jobId: string; attempt: number }>;
          for (const job of preparations) this.send(connection, { type: 'LEASE', kind: 'PREPARATION', ...job, accepted: true, cancelRequested: true });
        }
      }
      this.wake();
    } catch (error) { this.logger.warn({ err: error }, '에이전트 스케줄러 주기 처리 실패'); }
  }

  private activeLeaseCount(clientId: string): number {
    const backtests = this.database.sqlite.prepare("SELECT COUNT(*) AS n FROM backtest_jobs WHERE agent_id = ? AND status IN ('STARTING', 'RUNNING', 'CANCELLING')").get(clientId) as { n: number };
    const preparations = this.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_preparation_leases l JOIN backtest_preparation_jobs j ON j.id = l.job_id WHERE client_id = ? AND j.status = 'RUNNING'").get(clientId) as { n: number };
    return backtests.n + preparations.n;
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.queue.events.off('queued', this.wake);
    this.backtests.events.off('job', this.wake);
    this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const { socket } of this.connections.values()) socket.terminate();
    this.connections.clear();
    await this.localClient?.stop();
    // 서버 자식의 종료를 확인한 뒤에만 로컬 리스를 반환한다. 원격 리스는 만료까지 유지한다.
    if (this.localClient) this.invalidateClientLeases(LOCAL_AGENT_ID);
    this.backtests.stop();
    await this.dataQueue.stop();
    await this.snapshots.stop();
    await this.dispatching;
  }
}
