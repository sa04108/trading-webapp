import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';
import { JobQueue } from '../../src/server/modules/backtest/application/job-queue.js';
import { BacktestRefreshService, type BacktestRefreshDeps } from '../../src/server/modules/backtest/application/backtest-refresh-service.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { BacktestPreparationOrchestrator } from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';

const request = { strategyId: 'test', parameters: { window: 5 }, universeRule: {} } as unknown as BacktestRequest;
const clone = { kind: 'CLONE' } as const;
const period = { kind: 'PERIOD_VALIDATION', config: { mode: 'HOLDOUT', splitDate: '2023-01-01' } } as const;

describe('영속 데이터 업데이트 작업', () => {
  let dir: string;
  let db: DatabaseHandle;
  let source: string;
  let deps: BacktestRefreshDeps;
  let service: BacktestRefreshService;
  let identity: string;
  let prepStatus: string;
  let startCount: number;
  let previewFresh: boolean;
  let services: BacktestRefreshService[];
  const makeService = () => { const instance = new BacktestRefreshService(deps); services.push(instance); return instance; };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-'));
    db = openDatabase(path.join(dir, 'app.sqlite'));
    for (const id of ['alice', 'bob']) db.sqlite.prepare("INSERT INTO users (id, username, password_hash, created_at_ms, updated_at_ms) VALUES (?, ?, 'unused', 0, 0)").run(id, id);
    const clock = { now: () => 1000 };
    source = new JobQueue(db, clock).enqueue(request).id;
    db.sqlite.prepare("INSERT INTO backtest_preparation_jobs (id, request_hash, request_json, status, phase, created_at_ms, updated_at_ms) VALUES ('original-prep', 'old', '{}', 'COMPLETED', 'FINALIZING', 1, 1)").run();
    db.sqlite.prepare("UPDATE backtest_jobs SET preparation_job_id='original-prep' WHERE id=?").run(source);
    identity = 'v1'; prepStatus = 'RUNNING'; startCount = 0; previewFresh = true; services = [];
    const preparation = {
      get: (id: string) => ({ id, status: prepStatus }),
      getActive: () => startCount && prepStatus === 'RUNNING' ? { id: startCount === 1 ? 'fresh-prep' : `fresh-prep-${startCount}` } : null,
      getFreshPreviewDetails: (_request: BacktestRequest, id?: string) => previewFresh && prepStatus === 'COMPLETED' && id === (startCount === 1 ? 'fresh-prep' : `fresh-prep-${startCount}`) ? { preview: { preparationJobId: id } } : null,
      start: () => {
        startCount++;
        const id = startCount === 1 ? 'fresh-prep' : `fresh-prep-${startCount}`;
        db.sqlite.prepare("INSERT INTO backtest_preparation_jobs (id, request_hash, request_json, status, phase, created_at_ms, updated_at_ms) VALUES (?, 'hash', '{}', 'RUNNING', 'FINALIZING', 1, 1)").run(id);
        return { id };
      },
      cancel: vi.fn(),
    } as unknown as BacktestPreparationOrchestrator;
    deps = { database: db, clock, preparation, snapshot: () => ({ request, warnings: [] }), runtimeIdentity: () => identity,
      buildSubmission: vi.fn(async () => () => '/result'), onFinished: vi.fn() };
    service = makeService();
  });
  afterEach(async () => { for (const instance of services) await instance.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('요청 번호를 중복 제거하고 소유자별로 격리하며 충돌을 거절한다', () => {
    const job = service.create('alice', 'request', source, clone);
    expect(service.create('alice', 'request', source, clone).id).toBe(job.id);
    expect(() => service.create('alice', 'request', source, period)).toThrow('다른 작업');
    expect(() => service.get('bob', job.id)).toThrow();
    expect(() => service.cancel('bob', job.id)).toThrow();
    expect(service.create('bob', 'request', source, clone).id).not.toBe(job.id);
  });

  it('재시작 후 새 준비 결과로 이어 실행한다', async () => {
    const queue = new JobQueue(db, { now: () => 1000 });
    db.sqlite.prepare("UPDATE backtest_jobs SET status='COMPLETED', completed_at_ms=1000 WHERE id=?").run(source);
    const job = service.create('alice', 'request', source, clone);
    await service.pump();
    expect(service.get('alice', job.id)).toMatchObject({ status: 'PREPARING', preparationJobId: 'fresh-prep' });
    expect(queue.deleteJob(source)).toBe(false);
    await service.stop();
    prepStatus = 'COMPLETED';
    const resumed = makeService();
    await resumed.pump();
    expect(resumed.get('alice', job.id)).toMatchObject({ status: 'COMPLETED', resultHref: '/result' });
    expect(deps.buildSubmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ preparationJobId: 'fresh-prep' }));
    expect(startCount).toBe(1);
    expect(db.sqlite.prepare('SELECT preparation_job_id FROM backtest_jobs WHERE id=?').get(source)).toEqual({ preparation_job_id: 'original-prep' });
    expect(queue.deleteJob(source)).toBe(true);
    expect(queue.getJob(source)).toBeNull();
  });

  it('기존 최적화 홀드아웃 요청은 새 설정으로 재전송해도 같은 작업을 이어간다', async () => {
    const action = { ...period, config: { ...period.config, optimization: { axes: [{ key: 'window', values: [5, 20] }], objective: 'sharpe' as const, minTrades: 5, maxDrawdownPct: 30 } } };
    const job = service.create('alice', 'period-request', source, action);
    const legacy = JSON.stringify({ ...action, config: { ...action.config, mode: 'OPTIMIZED_HOLDOUT' } });
    db.sqlite.prepare('UPDATE backtest_refresh_jobs SET action_json=? WHERE id=?').run(legacy, job.id);
    expect(service.get('alice', job.id).action).toEqual(action);
    expect(service.create('alice', 'period-request', source, action).id).toBe(job.id);
    expect(() => service.create('alice', 'period-request', source, period)).toThrow('다른 작업');
    await service.pump();
    expect(service.get('alice', job.id)).toMatchObject({ status: 'COMPLETED', action });
    expect(deps.buildSubmission).toHaveBeenCalledTimes(1);
    expect(db.sqlite.prepare('SELECT action_json FROM backtest_refresh_jobs WHERE id=?').get(job.id)).toEqual({ action_json: legacy });
  });

  it('제출 트랜잭션 오류는 생성된 후속 작업을 되돌린다', async () => {
    deps.buildSubmission = async () => () => {
      db.sqlite.prepare("INSERT INTO users (id, username, password_hash, created_at_ms, updated_at_ms) VALUES ('target', 'target', 'x', 0, 0)").run();
      throw new Error('submit failed');
    };
    const job = service.create('alice', 'request', source, period);
    await service.pump();
    expect(service.get('alice', job.id)).toMatchObject({ status: 'FAILED', error: 'submit failed' });
    expect(db.sqlite.prepare("SELECT id FROM users WHERE id='target'").get()).toBeUndefined();
  });

  it('완료 알림 저장 실패 후 재시작해도 후속 작업을 중복 생성하지 않는다', async () => {
    const submit = vi.fn(() => '/result');
    deps.buildSubmission = vi.fn(async () => submit);
    deps.onFinished = vi.fn().mockImplementationOnce(() => { throw new Error('notification failed'); });
    const job = service.create('alice', 'request', source, period);
    await expect(service.pump()).rejects.toThrow('notification failed');
    expect(service.get('alice', job.id)).toMatchObject({ status: 'COMPLETED', resultHref: '/result' });
    await service.stop();
    const resumed = makeService();
    await resumed.pump();
    await resumed.pump();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(deps.onFinished).toHaveBeenCalledTimes(2);
    expect(deps.onFinished).toHaveBeenLastCalledWith(expect.objectContaining({ id: job.id, status: 'COMPLETED' }));
  });

  it('비동기 제출 검증 중 취소하면 후속 작업을 만들지 않는다', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const submit = vi.fn(() => '/result');
    deps.buildSubmission = async () => { entered(); await waiting; return submit; };
    const job = service.create('alice', 'request', source, period);
    const pumping = service.pump();
    await started;
    service.cancel('alice', job.id);
    release(); await pumping;
    expect(submit).not.toHaveBeenCalled();
    expect(service.get('alice', job.id).status).toBe('CANCELLED');
  });

  it('비동기 검증 중 실행 기준이 바뀌면 제출하지 않고 실패를 알린다', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const submit = vi.fn(() => '/result');
    deps.buildSubmission = async () => { entered(); await waiting; return submit; };
    const job = service.create('alice', 'request', source, period);
    const pumping = service.pump();
    await started;
    identity = 'v2';
    release(); await pumping;
    expect(submit).not.toHaveBeenCalled();
    expect(service.get('alice', job.id)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('변경') });
    expect(deps.onFinished).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, status: 'FAILED' }));
  });

  it('제출 검증 중 미리보기가 오래되면 다시 준비하고 새 결과로 실행한다', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const submit = vi.fn(() => '/result');
    deps.buildSubmission = vi.fn(async () => { entered(); await waiting; return submit; });
    const job = service.create('alice', 'request', source, clone);
    await service.pump();
    prepStatus = 'COMPLETED';
    const pumping = service.pump();
    await started;
    previewFresh = false;
    release(); await pumping;
    expect(submit).not.toHaveBeenCalled();
    expect(service.get('alice', job.id)).toMatchObject({ status: 'QUEUED', preparationJobId: null });
    await service.pump();
    expect(service.get('alice', job.id)).toMatchObject({ status: 'PREPARING', preparationJobId: 'fresh-prep-2' });
    previewFresh = true;
    await service.pump();
    expect(service.get('alice', job.id)).toMatchObject({ status: 'COMPLETED', resultHref: '/result' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('기간검증과 공유 준비를 시작하기 전에 각각 공시를 확인한다', async () => {
    const refresh = vi.fn(async () => {});
    deps.refreshProviderFilings = refresh;
    const first = service.create('alice', 'one', source, clone);
    await service.pump();
    const second = service.create('bob', 'two', source, clone);
    const third = service.create('alice', 'three', source, period);
    await service.pump();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(service.get('alice', first.id).preparationJobId).toBe('fresh-prep');
    expect(service.get('bob', second.id).preparationJobId).toBe('fresh-prep');
    expect(service.get('alice', third.id).status).toBe('COMPLETED');
    expect(startCount).toBe(1);
  });

  it('공시 확인을 기다리는 동안 취소하면 준비나 제출을 시작하지 않는다', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    deps.refreshProviderFilings = async () => { entered(); await waiting; };
    const job = service.create('alice', 'request', source, period);
    const pumping = service.pump();
    await started;
    service.cancel('alice', job.id);
    release(); await pumping;
    expect(deps.buildSubmission).not.toHaveBeenCalled();
    expect(startCount).toBe(0);
    expect(service.get('alice', job.id).status).toBe('CANCELLED');
  });

  it('공유 준비 작업을 한 소유자가 취소해도 다른 작업을 유지한다', async () => {
    const first = service.create('alice', 'one', source, clone);
    const second = service.create('bob', 'two', source, clone);
    await service.pump();
    expect(service.get('bob', second.id).preparationJobId).toBe('fresh-prep');
    service.cancel('alice', first.id);
    expect(deps.preparation.cancel).not.toHaveBeenCalled();
    expect(service.get('bob', second.id).status).toBe('PREPARING');
  });

  it('실행 기준 변경은 실패와 알림으로 끝내고 재시도는 원래 설정을 한 번만 복원한다', async () => {
    const action = period;
    const job = service.create('alice', 'request', source, action);
    identity = 'v2'; await service.pump();
    expect(service.get('alice', job.id)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('변경') });
    expect(deps.buildSubmission).not.toHaveBeenCalled();
    expect(deps.onFinished).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, status: 'FAILED' }));
    const retry = service.retry('alice', job.id);
    expect(retry.action).toEqual(action);
    expect(service.retry('alice', job.id).id).toBe(retry.id);
  });
});
