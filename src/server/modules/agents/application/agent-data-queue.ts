import { createHash } from 'node:crypto';
import { readRuntimeVersions } from '../../../../runtime/shared/runtime-versions.js';
import type { DatabaseHandle } from '../../../../runtime/shared/db/database.js';
import type { Logger } from '../../../shared/logger.js';
import { KrxQuotaError } from '../../../../runtime/modules/market-data/application/ports.js';
import { agentDataRequestSchema, type AgentDataRequest, type AgentLease } from '../../../../shared/agent-protocol.js';
import type { DatasetSnapshots } from './dataset-snapshots.js';

export class AgentCollectionPaused extends Error {
  constructor(message: string, readonly resumeAtMs: number) { super(message); }
}
interface DataRequestRow { id: string; request_json: string; status: string; available_version: number | null; attempts: number }

export class AgentDataQueue {
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly collectionVersion: string;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly snapshots: DatasetSnapshots,
    private readonly collect: (request: AgentDataRequest, shouldStop: () => boolean) => Promise<void>,
    private readonly onReady: (kind: AgentLease['kind'], jobId: string, error?: string) => void,
    private readonly logger: Logger,
    options?: { readonly collectionVersion: string },
  ) {
    this.collectionVersion = options?.collectionVersion ?? readRuntimeVersions().collectionVersion;
  }

  recover(): void {
    this.database.sqlite.prepare("UPDATE agent_data_requests SET status = 'QUEUED' WHERE status = 'RUNNING'").run();
  }

  /** 같은 데이터 요구는 여러 작업이 공유하고, 데이터 대기는 계산 재시도에 포함하지 않는다. */
  request(kind: AgentLease['kind'], jobId: string, requestedVersion: number, input: AgentDataRequest): void {
    const request = agentDataRequestSchema.parse(input);
    if ('dates' in request) request.dates = [...new Set(request.dates)].sort();
    else if (request.kind === 'REGISTER') request.symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));
    else {
      if (request.fromYear > request.toYear || request.toYear - request.fromYear > 50) throw new Error('데이터 요청 연도 범위가 올바르지 않습니다');
      request.symbols = [...new Set(request.symbols)].sort();
    }
    const json = JSON.stringify(request);
    // 이전 수집기의 완료 요청이 새 수집기의 재검증 요구를 가로막지 않게 한다.
    const id = createHash('sha256').update(this.collectionVersion).update('\0').update(json).digest('hex');
    const now = Date.now();
    const previous = this.database.sqlite.prepare('SELECT * FROM agent_data_requests WHERE id = ?').get(id) as DataRequestRow | undefined;
    if (previous?.status === 'COMPLETED' && previous.available_version === requestedVersion) {
      throw new Error('서버가 수집을 완료한 데이터로도 같은 결손이 남았습니다. 공급자 응답과 데이터 범위를 확인하세요.');
    }
    this.database.sqlite.prepare(`INSERT INTO agent_data_requests (id, request_json, status, created_at_ms, updated_at_ms)
      VALUES (?, ?, 'QUEUED', ?, ?) ON CONFLICT(id) DO UPDATE SET
      status = CASE WHEN status IN ('COMPLETED', 'FAILED') AND COALESCE(available_version, 0) <= ? THEN 'QUEUED' ELSE status END,
      attempts = CASE WHEN status IN ('COMPLETED', 'FAILED') THEN 0 ELSE attempts END`).run(id, json, now, now, requestedVersion);
    this.database.sqlite.prepare(`INSERT INTO agent_data_waits (kind, job_id, request_id, requested_version)
      VALUES (?, ?, ?, ?) ON CONFLICT(kind, job_id) DO UPDATE SET request_id = excluded.request_id, requested_version = excluded.requested_version`)
      .run(kind, jobId, id, requestedVersion);
  }

  tick(): void {
    if (this.stopped || this.running) return;
    this.running = this.runNext().catch((error: unknown) => {
      this.logger.error({ err: error }, '에이전트 데이터 수집 큐 처리 실패');
    }).finally(() => { this.running = null; });
  }

  private async runNext(): Promise<void> {
    this.resumeReady();
    const row = this.database.sqlite.prepare(`SELECT * FROM agent_data_requests WHERE status = 'QUEUED' AND next_attempt_at_ms <= ? ORDER BY created_at_ms LIMIT 1`)
      .get(Date.now()) as DataRequestRow | undefined;
    if (!row) return;
    this.database.sqlite.prepare("UPDATE agent_data_requests SET status = 'RUNNING', updated_at_ms = ? WHERE id = ?").run(Date.now(), row.id);
    try {
      await this.collect(agentDataRequestSchema.parse(JSON.parse(row.request_json)), () => this.stopped);
      if (this.stopped) return;
      const manifest = await this.snapshots.ensureLatest();
      this.database.sqlite.prepare("UPDATE agent_data_requests SET status = 'COMPLETED', available_version = ?, error = NULL, updated_at_ms = ? WHERE id = ?")
        .run(manifest.version, Date.now(), row.id);
    } catch (error) {
      if (this.stopped) return;
      const quota = error instanceof AgentCollectionPaused || error instanceof KrxQuotaError;
      const attempts = row.attempts + (quota ? 0 : 1);
      const nextMidnight = Math.floor((Date.now() + 9 * 3600_000) / 86400_000 + 1) * 86400_000 - 9 * 3600_000;
      const next = error instanceof AgentCollectionPaused ? error.resumeAtMs : quota ? nextMidnight : Date.now() + 5000 * 2 ** attempts;
      this.database.sqlite.prepare('UPDATE agent_data_requests SET status = ?, attempts = ?, next_attempt_at_ms = ?, error = ?, updated_at_ms = ? WHERE id = ?')
        .run(attempts >= 3 ? 'FAILED' : 'QUEUED', attempts, next, error instanceof Error ? error.message : String(error), Date.now(), row.id);
    }
    this.resumeReady();
  }

  private resumeReady(): void {
    const rows = this.database.sqlite.prepare(`SELECT w.kind, w.job_id, r.status, r.error FROM agent_data_waits w
      JOIN agent_data_requests r ON r.id = w.request_id WHERE r.status IN ('COMPLETED', 'FAILED')`).all() as Array<{ kind: AgentLease['kind']; job_id: string; status: string; error: string | null }>;
    for (const row of rows) {
      this.database.sqlite.transaction(() => {
        this.onReady(row.kind, row.job_id, row.status === 'FAILED' ? row.error ?? '데이터 수집 실패' : undefined);
        this.database.sqlite.prepare('DELETE FROM agent_data_waits WHERE kind = ? AND job_id = ?').run(row.kind, row.job_id);
      })();
    }
  }

  async stop(): Promise<void> { this.stopped = true; await this.running; }
}
