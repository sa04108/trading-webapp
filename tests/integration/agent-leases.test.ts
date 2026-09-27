import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';
import { AgentPreparationQueue } from '../../src/server/modules/agents/application/agent-preparation-queue.js';
import { AgentDataQueue } from '../../src/server/modules/agents/application/agent-data-queue.js';
import { PreparationPreviewCache } from '../../src/runtime/modules/backtest/application/preparation-preview-cache.js';
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

  it('같은 준비 진행률의 heartbeat는 마지막 진행 시각을 바꾸지 않는다', () => {
    seedPreparation('prep-progress');
    const lease = preparations.claim(clientId, dataset)!;
    const progress = {
      phase: 'RESOLVING_STAGES' as const,
      overallProgress: 50,
      doneSymbols: 1,
      totalSymbols: 2,
      savedFacts: 1,
      gapCount: 0,
      resolutionPass: 1,
    };

    vi.spyOn(Date, 'now').mockReturnValue(100);
    expect(preparations.heartbeat(clientId, lease, progress).accepted).toBe(true);
    vi.mocked(Date.now).mockReturnValue(200);
    expect(preparations.heartbeat(clientId, lease, progress).accepted).toBe(true);

    expect(database.sqlite.prepare(
      'SELECT j.updated_at_ms, l.last_received_at_ms FROM backtest_preparation_jobs j JOIN agent_preparation_leases l ON l.job_id = j.id WHERE j.id = ?',
    ).get(lease.jobId)).toEqual({ updated_at_ms: 100, last_received_at_ms: 200 });
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

  it('공유 수집 진행을 모든 대기 작업에 알리고 요청 행에서 한 번만 읽는다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const collect = vi.fn(async (_request, _stop, report) => {
      report({ activity: 'COLLECTING_MARKET', unit: 'DATES', completed: 1, total: 2, currentItem: '2026-01-05' });
      await gate;
      report({ activity: 'COLLECTING_MARKET', unit: 'DATES', completed: 2, total: 2, currentItem: '2026-01-06' });
    });
    const changed = vi.fn();
    const snapshots = { ensureLatest: async () => ({ ...dataset, version: 2 }) } as DatasetSnapshots;
    const queue = new AgentDataQueue(database, snapshots, collect, vi.fn(), pino({ enabled: false }), {
      onProgress: changed,
    });
    queue.request('PREPARATION', 'shared-one', 1, { kind: 'MARKET', dates: ['2026-01-05', '2026-01-06'] });
    queue.request('PREPARATION', 'shared-two', 1, { kind: 'MARKET', dates: ['2026-01-05', '2026-01-06'] });
    queue.tick();
    await vi.waitFor(() => expect(queue.progressForJob('shared-one')).toMatchObject({ completed: 1, total: 2, currentItem: '2026-01-05' }));
    expect(queue.progressForJob('shared-two')).toMatchObject({ completed: 1, total: 2 });
    expect(changed).toHaveBeenCalledWith('PREPARATION', 'shared-one');
    expect(changed).toHaveBeenCalledWith('PREPARATION', 'shared-two');
    release();
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    await queue.stop();
  });

  it('수집 실행 버전이 달라져도 완료된 같은 요청을 다시 수집하지 않는다', async () => {
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
      expect(() => current.request('PREPARATION', 'new-job', 2, request)).toThrow('같은 결손');
      current.tick();
      await current.stop();
      expect(collect).toHaveBeenCalledTimes(1);
      expect(database.sqlite.prepare('SELECT status FROM agent_data_requests').all()).toEqual([{ status: 'COMPLETED' }]);
    } finally { await previous.stop(); await current.stop(); }
  });

  it('실행 해시만 오래된 준비 결과는 실제 입력 버전이 같으면 검증해 수락한다', () => {
    seedPreparation('old-collection');
    const revision = new PreparationPreviewCache(database).revision();
    const previous = { ...dataset, sourceRevision: revision, collectionVersion: 'c'.repeat(64) };
    const lease = preparations.claim(clientId, previous)!;
    const result = validPreparationResult(revision);
    expect(preparations.finish(clientId, lease, 'COMPLETED', result, previous)).toBe(true);
    expect(database.sqlite.prepare('SELECT status FROM backtest_preparation_jobs WHERE id = ?').get(lease.jobId)).toEqual({ status: 'COMPLETED' });
    expect(new PreparationPreviewCache(database).isFresh(lease.jobId)).toBe(true);
    expect(preparations.claim(clientId, dataset)).toBeNull();
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

  it('지정 jobId만 claim하고 defer 후 새 attempt만 유효하게 만든다', () => {
    const insert = database.sqlite.prepare("INSERT INTO backtest_jobs (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json, created_at_ms, estimated_bars) VALUES (?, 'QUEUED', '{}', 'test', '{}', '[]', ?, ?)");
    insert.run('earlier', 1, 1000);
    insert.run('target', 2, 1000);
    const queue = new JobQueue(database, { now: () => 100 });
    const options = {
      agentId: clientId,
      leaseTokenHash: 'a'.repeat(64),
      leaseExpiresAtMs: 10_000,
      runnerVersion: 'test',
      maxAttempts: 3,
      maxBars: 2000,
      jobId: 'target',
    };

    const first = queue.claimNextLease(options)!;
    expect(first.id).toBe('target');
    expect(first.attempt).toBe(1);
    expect(queue.deferLease({
      jobId: first.id,
      attempt: first.attempt,
      leaseTokenHash: options.leaseTokenHash,
      nowMs: 101,
      reason: '일시적인 메모리 부족',
    })).toBe('QUEUED');

    expect(queue.finishLease({
      jobId: first.id,
      attempt: first.attempt,
      leaseTokenHash: options.leaseTokenHash,
      nowMs: 102,
      status: 'FAILED',
      error: '늦게 도착한 이전 실패',
    })).toBeNull();

    for (let expectedAttempt = 2; expectedAttempt <= 4; expectedAttempt++) {
      const hash = String(expectedAttempt).repeat(64);
      const lease = queue.claimNextLease({
        ...options,
        leaseTokenHash: hash,
        jobId: 'target',
      })!;
      expect(lease.id).toBe('target');
      expect(lease.attempt).toBe(expectedAttempt);
      if (expectedAttempt === 2) {
        expect(queue.finishLease({
          jobId: first.id,
          attempt: first.attempt,
          leaseTokenHash: options.leaseTokenHash,
          nowMs: 103,
          status: 'FAILED',
          error: 'reclaim 뒤 도착한 이전 실패',
        })).toBeNull();
        expect(queue.getJob(lease.id)?.status).toBe('STARTING');
      }
      expect(queue.deferLease({
        jobId: lease.id,
        attempt: lease.attempt,
        leaseTokenHash: hash,
        nowMs: 102 + expectedAttempt,
        reason: '자원 재측정 대기',
      })).toBe('QUEUED');
    }

    expect(database.sqlite.prepare('SELECT status, attempt, lease_failures, error, agent_id, pid, lease_token_hash, lease_expires_at_ms, runner_version, started_at_ms, completed_at_ms FROM backtest_jobs WHERE id = ?').get('target')).toEqual({
      status: 'QUEUED',
      attempt: 4,
      lease_failures: 0,
      error: '자원 재측정 대기',
      agent_id: null,
      pid: null,
      lease_token_hash: null,
      lease_expires_at_ms: null,
      runner_version: null,
      started_at_ms: null,
      completed_at_ms: null,
    });
    expect(queue.claimNextLease({ ...options, jobId: 'missing' })).toBeNull();
  });

  it('defer는 stale·만료·RUNNING 리스를 거부하고 취소 경합에서는 취소를 유지한다', () => {
    database.sqlite.prepare("INSERT INTO backtest_jobs (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json, created_at_ms, estimated_bars) VALUES ('defer-race', 'QUEUED', '{}', 'test', '{}', '[]', 1, 1000)").run();
    const nowMs = 100;
    const queue = new JobQueue(database, { now: () => nowMs });
    const hash = 'b'.repeat(64);
    const lease = queue.claimNextLease({
      agentId: clientId,
      leaseTokenHash: hash,
      leaseExpiresAtMs: 1000,
      runnerVersion: 'test',
      maxAttempts: 3,
    })!;

    expect(queue.deferLease({
      jobId: lease.id,
      attempt: lease.attempt,
      leaseTokenHash: 'c'.repeat(64),
      nowMs,
      reason: 'wrong token',
    })).toBeNull();
    expect(queue.deferLease({
      jobId: lease.id,
      attempt: lease.attempt + 1,
      leaseTokenHash: hash,
      nowMs,
      reason: 'wrong attempt',
    })).toBeNull();
    expect(queue.deferLease({
      jobId: lease.id,
      attempt: lease.attempt,
      leaseTokenHash: hash,
      nowMs: 1001,
      reason: 'expired',
    })).toBeNull();

    database.sqlite.prepare("UPDATE backtest_jobs SET status = 'RUNNING' WHERE id = ?").run(lease.id);
    expect(queue.deferLease({
      jobId: lease.id,
      attempt: lease.attempt,
      leaseTokenHash: hash,
      nowMs,
      reason: 'already running',
    })).toBeNull();
    database.sqlite.prepare("UPDATE backtest_jobs SET status = 'CANCELLING' WHERE id = ?").run(lease.id);
    expect(queue.deferLease({
      jobId: lease.id,
      attempt: lease.attempt,
      leaseTokenHash: hash,
      nowMs,
      reason: 'cancel raced with defer',
    })).toBe('CANCELLED');
    expect(queue.getJob(lease.id)).toMatchObject({
      status: 'CANCELLED',
      error: null,
      leaseFailures: 0,
      leaseTokenHash: null,
      leaseExpiresAtMs: null,
      completedAtMs: nowMs,
    });
  });
});

function validPreparationResult(dataRevision: number) {
  const schedule = [{ rebalanceDate: '2026-01-05', effectiveDate: '2026-01-05', members: [{ symbol: '005930', standardCode: 'KR7005930003' }], excludedNonTradingCount: 0 }];
  return {
    dataRevision,
    fundamentalSymbols: [],
    preview: {
      schedule,
      scheduleHash: createHash('sha256').update(JSON.stringify(schedule)).digest('hex'),
      unionSymbols: ['005930'], diagnostics: [], stages: [], uncoveredDates: [],
      periodCovered: true, missingCandleSymbols: [], warnings: [],
    },
  };
}
