import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';
import { AgentPreparationQueue } from '../../src/server/modules/agents/application/agent-preparation-queue.js';
import { AgentDataQueue } from '../../src/server/modules/agents/application/agent-data-queue.js';
import { AgentRegistry } from '../../src/server/modules/agents/application/agent-registry.js';
import { JobQueue } from '../../src/server/modules/backtest/application/job-queue.js';
import { pino } from 'pino';
import type { DatasetSnapshots } from '../../src/server/modules/agents/application/dataset-snapshots.js';
import type { DatasetManifest } from '../../src/shared/agent-protocol.js';

let database: DatabaseHandle;
let preparations: AgentPreparationQueue;
let clientId: string;
const dataset: DatasetManifest = { version: 1, datasetId: randomUUID(), sourceRevision: 0, collectionVersion: readRuntimeVersions().collectionVersion, schemaVersion: 1, sha256: 'a'.repeat(64), bytes: 1 };
beforeEach(() => {
  database = openDatabase(':memory:');
  preparations = new AgentPreparationQueue(database, () => undefined);
  clientId = new AgentRegistry(database).issue('test').id;
});
afterEach(() => { database.close(); vi.restoreAllMocks(); });
function seedPreparation(id: string) {
  database.sqlite.prepare("INSERT INTO backtest_preparation_jobs (id, request_hash, request_json, status, phase, created_at_ms, updated_at_ms) VALUES (?, ?, '{}', 'QUEUED', 'MARKET_DATA', 1, 1)").run(id, id);
}

describe('에이전트 리스와 데이터 대기', () => {
  it('연결이 바뀌어도 유효한 토큰은 유지되며 다른 장치와 만료된 응답은 거부한다', () => {
    seedPreparation('prep-one');
    const lease = preparations.claim(clientId, dataset)!;
    expect(preparations.heartbeat(clientId, lease).accepted).toBe(true);
    expect(preparations.heartbeat('other', lease).accepted).toBe(false);
    database.sqlite.prepare('UPDATE agent_preparation_leases SET lease_expires_at_ms = 1 WHERE job_id = ?').run(lease.jobId);
    preparations.sweep();
    const next = preparations.claim(clientId, dataset)!;
    expect(next.attempt).toBe(lease.attempt + 1);
    expect(preparations.heartbeat(clientId, lease).accepted).toBe(false);
    expect(preparations.finish(clientId, lease, 'FAILED', null, dataset)).toBe(false);
    expect(preparations.heartbeat(clientId, next).accepted).toBe(true);
  });

  it('수집 대기는 실패 횟수를 소모하지 않고 다른 준비 작업을 실행한다', () => {
    seedPreparation('prep-one'); seedPreparation('prep-two');
    const lease = preparations.claim(clientId, dataset)!;
    expect(preparations.waitForData(clientId, lease, () => undefined)).toBe(true);
    expect(preparations.claim(clientId, dataset)?.jobId).toBe('prep-two');
    preparations.resume(lease.jobId);
    const next = preparations.claim(clientId, { ...dataset, version: 2 })!;
    expect(next.attempt).toBe(2);
    expect(database.sqlite.prepare('SELECT failures FROM agent_preparation_leases WHERE job_id = ?').get(lease.jobId)).toEqual({ failures: 0 });
  });

  it('동일한 수집 요청은 하나로 합쳐지고 준비된 버전 이후에 대기 작업을 재개한다', async () => {
    const collect = vi.fn(async () => undefined);
    const ready = vi.fn();
    const snapshots = { ensureLatest: async () => ({ ...dataset, version: 2 }) } as DatasetSnapshots;
    const queue = new AgentDataQueue(database, snapshots, collect, ready, pino({ enabled: false }));
    queue.request('PREPARATION', 'prep-one', 1, { kind: 'MARKET', dates: ['2026-01-06', '2026-01-05'] });
    queue.request('PREPARATION', 'prep-two', 1, { kind: 'MARKET', dates: ['2026-01-05', '2026-01-06'] });
    queue.tick();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
    await queue.stop();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(database.sqlite.prepare('SELECT available_version FROM agent_data_requests').get()).toEqual({ available_version: 2 });
    expect(() => queue.request('PREPARATION', 'prep-three', 2, { kind: 'MARKET', dates: ['2026-01-05', '2026-01-06'] })).toThrow('같은 결손');
  });

  it('수집 버전이 달라지면 이전 완료 요청을 재사용하지 않고 새 수집을 실행한다', async () => {
    const collect = vi.fn(async () => undefined);
    const ready = vi.fn();
    const snapshots = { ensureLatest: async () => ({ ...dataset, version: 2 }) } as DatasetSnapshots;
    const previous = new AgentDataQueue(database, snapshots, collect, ready, pino({ enabled: false }), { collectionVersion: 'a'.repeat(64) });
    const current = new AgentDataQueue(database, snapshots, collect, ready, pino({ enabled: false }), { collectionVersion: 'b'.repeat(64) });
    const request = { kind: 'MARKET' as const, dates: ['2026-01-05'] };
    try {
      previous.request('PREPARATION', 'old-job', 1, request);
      previous.tick();
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
      expect(() => current.request('PREPARATION', 'new-job', 2, request)).not.toThrow();
      current.tick();
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
      expect(collect).toHaveBeenCalledTimes(2);
      expect(database.sqlite.prepare('SELECT status FROM agent_data_requests').all()).toEqual([
        { status: 'COMPLETED' }, { status: 'COMPLETED' },
      ]);
    } finally { await previous.stop(); await current.stop(); }
  });

  it('옛 수집 버전의 준비 결과는 현재 미리보기로 확정하지 않고 실패 소모 없이 재배정한다', () => {
    seedPreparation('old-collection');
    const previous = { ...dataset, collectionVersion: 'c'.repeat(64) };
    const lease = preparations.claim(clientId, previous)!;
    expect(preparations.finish(clientId, lease, 'COMPLETED', null, previous)).toBe(true);
    expect(database.sqlite.prepare('SELECT status, preview_json FROM backtest_preparation_jobs WHERE id = ?').get(lease.jobId)).toEqual({ status: 'QUEUED', preview_json: null });
    expect(database.sqlite.prepare('SELECT failures, lease_token_hash FROM agent_preparation_leases WHERE job_id = ?').get(lease.jobId)).toEqual({ failures: 0, lease_token_hash: null });
    expect(preparations.heartbeat(clientId, lease).accepted).toBe(false);
    expect(preparations.claim(clientId, { ...dataset, version: 2 })).toMatchObject({ attempt: 2, dataset: { collectionVersion: dataset.collectionVersion } });
  });

  it('큰 백테스트를 작은 장치가 가져가지 않고 재시도 토큰으로 이전 결과를 차단한다', () => {
    const insert = database.sqlite.prepare("INSERT INTO backtest_jobs (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json, created_at_ms, estimated_bars) VALUES (?, 'QUEUED', '{}', 'test', '{}', '[]', ?, ?)");
    insert.run('large', 1, 4_000_000); insert.run('small', 2, 1000);
    const queue = new JobQueue(database, { now: () => Date.now() });
    const options = { agentId: clientId, leaseTokenHash: 'a'.repeat(64), leaseExpiresAtMs: Date.now() + 90_000, runnerVersion: 'test', maxAttempts: 3, maxBars: 2000 };
    expect(queue.claimNextLease(options)?.id).toBe('small');
    expect(queue.claimNextLease(options)).toBeNull();
    expect(queue.claimNextLease({ ...options, maxBars: 5_000_000 })?.id).toBe('large');
    for (let attempt = 1; attempt <= 3; attempt++) {
      database.sqlite.prepare("UPDATE backtest_jobs SET lease_expires_at_ms = 1 WHERE id = 'small'").run();
      queue.recoverExpiredLeases(3);
      if (attempt < 3) expect(queue.claimNextLease(options)?.id).toBe('small');
    }
    expect(queue.getJob('small')?.status).toBe('FAILED');
  });
});
