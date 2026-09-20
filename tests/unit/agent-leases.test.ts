import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';
import { AgentPreparationQueue } from '../../src/server/modules/agents/application/agent-preparation-queue.js';
import { AgentDataQueue } from '../../src/server/modules/agents/application/agent-data-queue.js';
import { ProviderRequestBlockedError } from '../../src/server/shared/provider-request-policy.js';
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

  it('승인 차단은 재시도 시각과 재시작·동일 요청에도 자동 수집하지 않는다', async () => {
    const collect = vi.fn(async () => { throw new ProviderRequestBlockedError('SOURCE_RECOVERY', 'a'.repeat(64), '원문 해시 불일치'); });
    const ready = vi.fn();
    const snapshots = { ensureLatest: vi.fn(async () => dataset) } as unknown as DatasetSnapshots;
    const queue = new AgentDataQueue(database, snapshots, collect, ready, pino({ enabled: false }));
    const request = { kind: 'MARKET' as const, dates: ['2026-01-05'] };
    try {
      queue.request('PREPARATION', 'blocked-job', 1, request);
      queue.tick();
      await vi.waitFor(() => expect(queue.progressForJob('blocked-job')).toMatchObject({ activity: 'BLOCKED', nextResumeAtMs: null }));
      database.sqlite.prepare('UPDATE agent_data_requests SET next_attempt_at_ms = 0').run();
      queue.recover();
      queue.request('PREPARATION', 'another-job', 1, request);
      queue.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
      queue.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(collect).toHaveBeenCalledTimes(1);
      expect(ready).not.toHaveBeenCalled();
      expect(snapshots.ensureLatest).not.toHaveBeenCalled();
      expect(database.sqlite.prepare('SELECT status FROM agent_data_requests').all()).toEqual([{ status: 'BLOCKED' }]);
      expect(queue.progressForJob('another-job')).toMatchObject({ activity: 'BLOCKED', nextResumeAtMs: null });
    } finally { await queue.stop(); }
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

  it('실제 입력 버전이 바뀐 결과는 실패 소모 없이 새 입력으로 재배정한다', () => {
    seedPreparation('old-data');
    const revision = new PreparationPreviewCache(database).revision();
    const previous = { ...dataset, sourceRevision: revision };
    const lease = preparations.claim(clientId, previous)!;
    database.sqlite.prepare('UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1').run();
    expect(preparations.finish(clientId, lease, 'COMPLETED', validPreparationResult(revision), previous)).toBe(true);
    expect(database.sqlite.prepare('SELECT status, preview_json FROM backtest_preparation_jobs WHERE id = ?').get(lease.jobId)).toEqual({ status: 'QUEUED', preview_json: null });
    expect(database.sqlite.prepare('SELECT failures, lease_token_hash FROM agent_preparation_leases WHERE job_id = ?').get(lease.jobId)).toEqual({ failures: 0, lease_token_hash: null });
    expect(preparations.heartbeat(clientId, lease).accepted).toBe(false);
    expect(preparations.claim(clientId, { ...dataset, version: 2, sourceRevision: revision + 1 })).toMatchObject({ attempt: 2, dataset: { sourceRevision: revision + 1 } });
  });

  it('실행 해시 재사용 중에도 실제 결과의 버전과 일정 무결성을 검증한다', () => {
    seedPreparation('invalid-result');
    const revision = new PreparationPreviewCache(database).revision();
    const previous = { ...dataset, sourceRevision: revision, collectionVersion: 'c'.repeat(64) };
    const lease = preparations.claim(clientId, previous)!;
    expect(() => preparations.finish(clientId, lease, 'COMPLETED', validPreparationResult(revision + 1), previous)).toThrow('데이터 버전 또는 일정 해시');
    const altered = validPreparationResult(revision);
    altered.preview.scheduleHash = '0'.repeat(64);
    expect(() => preparations.finish(clientId, lease, 'COMPLETED', altered, previous)).toThrow('데이터 버전 또는 일정 해시');
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
