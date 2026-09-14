import { backtestExecutionTelemetrySchema } from '../../backtest/application/backtest-execution-telemetry.js';
import type { WebSocket } from 'ws';
import { MAX_BACKTEST_BARS } from '../../../shared/backtest-limits.js';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import type { Logger } from '../../../shared/logger.js';
import type { RemoteWorkerService } from '../../backtest/application/remote-worker-service.js';
import type { JobQueue } from '../../backtest/application/job-queue.js';
import { agentMessageSchema, type AgentMessage, type AgentLease, type ServerAgentMessage, type DatasetManifest } from '../../../../shared/agent-protocol.js';
import type { AgentRegistry } from './agent-registry.js';
import type { DatasetSnapshots } from './dataset-snapshots.js';
import type { AgentPreparationQueue } from './agent-preparation-queue.js';
import type { AgentDataQueue } from './agent-data-queue.js';

interface Connection { socket: WebSocket; ready: boolean; slots: number; maxBars: number; datasetVersion: number; lastMessageAt: number; assigning: boolean }

/** PC가 먼저 만든 연결로 서버가 작업을 전달한다. 연결과 작업 lease의 수명은 분리한다. */
export class AgentCoordinator {
  private readonly connections = new Map<string, Connection>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastPrunedAt = 0;

  constructor(
    private readonly database: DatabaseHandle,
    readonly registry: AgentRegistry,
    readonly snapshots: DatasetSnapshots,
    readonly preparations: AgentPreparationQueue,
    readonly dataQueue: AgentDataQueue,
    readonly backtests: RemoteWorkerService,
    private readonly queue: JobQueue,
    readonly runnerVersion: string,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.dataQueue.recover();
    this.backtests.start();
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
  }

  connect(clientId: string, socket: WebSocket): void {
    if (this.stopped) { socket.close(1012, 'server stopping'); return; }
    this.connections.get(clientId)?.socket.close(4001, 'connection replaced');
    const connection: Connection = { socket, ready: false, slots: 0, maxBars: 0, datasetVersion: 0, lastMessageAt: Date.now(), assigning: false };
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
    socket.once('close', () => { if (this.connections.get(clientId) === connection) this.connections.delete(clientId); });
  }

  private send(connection: Connection, message: ServerAgentMessage): void {
    if (connection.socket.readyState === 1) connection.socket.send(JSON.stringify(message));
  }

  private async message(clientId: string, connection: Connection, message: AgentMessage): Promise<void> {
    if (message.type === 'HELLO') {
      if (message.runnerVersion !== this.runnerVersion) {
        this.invalidateClientLeases(clientId);
        this.send(connection, { type: 'UPDATE_REQUIRED', runnerVersion: this.runnerVersion });
        return;
      }
      connection.ready = true;
      this.send(connection, { type: 'WELCOME', runnerVersion: this.runnerVersion });
      const dataset = await this.snapshots.ensureLatest();
      this.send(connection, { type: 'DATASET', dataset });
      return;
    }
    if (!connection.ready) throw new Error('HELLO가 필요합니다');
    if (message.type === 'CAPACITY') {
      connection.slots = message.slots;
      connection.maxBars = message.maxBars;
      connection.datasetVersion = message.datasetVersion;
      await this.assign(clientId, connection);
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
    const backtests = this.database.sqlite.prepare("SELECT id FROM backtest_jobs WHERE worker_id = ? AND status IN ('STARTING', 'RUNNING', 'CANCELLING')").all(`remote:${clientId}`) as Array<{ id: string }>;
    this.database.sqlite.transaction(() => {
      for (const { id } of preparations) {
        this.database.sqlite.prepare("UPDATE backtest_preparation_jobs SET status = CASE WHEN cancel_requested = 1 THEN 'CANCELLED' ELSE 'QUEUED' END, updated_at_ms = ? WHERE id = ?").run(Date.now(), id);
        this.database.sqlite.prepare('UPDATE agent_preparation_leases SET lease_token_hash = NULL, lease_expires_at_ms = NULL WHERE job_id = ?').run(id);
      }
      this.database.sqlite.prepare("UPDATE backtest_jobs SET status = CASE WHEN status = 'CANCELLING' THEN 'CANCELLED' ELSE 'QUEUED' END, worker_id = NULL, lease_token_hash = NULL, lease_expires_at_ms = NULL WHERE worker_id = ? AND status IN ('STARTING', 'RUNNING', 'CANCELLING')").run(`remote:${clientId}`);
    })();
    for (const { id } of preparations) this.preparations.resume(id);
    for (const { id } of backtests) this.backtests.events.emit('job', { jobId: id, kind: 'status' });
  }

  maxBacktestBars(): number {
    const capacities = [...this.connections.values()].filter((c) => c.ready && c.socket.readyState === 1 && c.maxBars > 0).map((c) => c.maxBars);
    return capacities.length > 0 ? Math.max(...capacities) : MAX_BACKTEST_BARS;
  }

  ownsBacktest(clientId: string, jobId: string): boolean { return this.queue.getJob(jobId)?.workerId === `remote:${clientId}`; }

  private async assign(clientId: string, connection: Connection): Promise<void> {
    if (connection.assigning || !connection.ready || connection.slots <= 0 || this.stopped) return;
    connection.assigning = true;
    try {
      const dataset = await this.snapshots.ensureLatest();
      if (this.connections.get(clientId) !== connection || connection.socket.readyState !== 1) return;
      if (connection.datasetVersion !== dataset.version) { this.send(connection, { type: 'DATASET', dataset }); return; }
      let active = this.activeLeaseCount(clientId);
      while (connection.slots > active) {
        // 이미 데이터가 준비된 백테스트를 먼저 주고, 남는 슬롯에 유니버스 계산을 배정한다.
        let lease: AgentLease | null = null;
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
    } finally { connection.assigning = false; }
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
      for (const [id, connection] of this.connections) {
        if (Date.now() - connection.lastMessageAt > 60_000 || !this.registry.active(id)) connection.socket.terminate();
        else {
          const cancelled = this.database.sqlite.prepare("SELECT id AS jobId, attempt FROM backtest_jobs WHERE worker_id = ? AND status = 'CANCELLING'").all(`remote:${id}`) as Array<{ jobId: string; attempt: number }>;
          for (const job of cancelled) this.send(connection, { type: 'LEASE', kind: 'BACKTEST', ...job, accepted: true, cancelRequested: true });
          const preparations = this.database.sqlite.prepare("SELECT j.id AS jobId, l.attempt FROM backtest_preparation_jobs j JOIN agent_preparation_leases l ON l.job_id = j.id WHERE l.client_id = ? AND j.status = 'RUNNING' AND j.cancel_requested = 1").all(id) as Array<{ jobId: string; attempt: number }>;
          for (const job of preparations) this.send(connection, { type: 'LEASE', kind: 'PREPARATION', ...job, accepted: true, cancelRequested: true });
          void this.assign(id, connection).catch((error: unknown) => this.logger.warn({ err: error }, '에이전트 작업 배정 실패'));
        }
      }
    } catch (error) { this.logger.warn({ err: error }, '에이전트 스케줄러 주기 처리 실패'); }
  }

  private activeLeaseCount(clientId: string): number {
    const backtests = this.database.sqlite.prepare("SELECT COUNT(*) AS n FROM backtest_jobs WHERE worker_id = ? AND status IN ('STARTING', 'RUNNING', 'CANCELLING')").get(`remote:${clientId}`) as { n: number };
    const preparations = this.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_preparation_leases l JOIN backtest_preparation_jobs j ON j.id = l.job_id WHERE client_id = ? AND j.status = 'RUNNING'").get(clientId) as { n: number };
    return backtests.n + preparations.n;
  }

  manifestForBacktest(jobId: string): DatasetManifest | null {
    const row = this.database.sqlite.prepare('SELECT dataset_version AS version FROM agent_backtest_datasets WHERE job_id = ?').get(jobId) as { version: number } | undefined;
    return row ? this.snapshots.get(row.version) : null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const { socket } of this.connections.values()) socket.terminate();
    this.connections.clear();
    this.backtests.stop();
    await this.dataQueue.stop();
    await this.snapshots.stop();
  }
}
