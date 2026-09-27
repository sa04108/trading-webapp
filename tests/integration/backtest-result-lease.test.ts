import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';
import { JobQueue } from '../../src/server/modules/backtest/application/job-queue.js';

let directory: string;
let database: DatabaseHandle;
let queue: JobQueue;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-result-lease-'));
  database = openDatabase(path.join(directory, 'app.sqlite'));
  queue = new JobQueue(database, { now: () => 100 });
  database.sqlite.exec(`INSERT INTO backtest_jobs (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json, created_at_ms)
    VALUES ('job', 'QUEUED', '{}', 'test', '{}', '[]', 1);
    CREATE TABLE result_probe (value INTEGER NOT NULL);`);
  queue.claimNextLease({ agentId: 'agent-a', leaseTokenHash: 'hash', leaseExpiresAtMs: 1000, runnerVersion: 'test', maxAttempts: 3 });
});
afterEach(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
function completion() {
  return { jobId: 'job', attempt: 1, leaseTokenHash: 'hash', nowMs: 100, resultSchemaVersion: 1,
    resultChecksum: 'checksum', processedBars: 10, validate: () => null,
    persist: () => { database.sqlite.exec('INSERT INTO result_probe VALUES (1)'); } };
}
function rows() { return database.sqlite.prepare('SELECT * FROM result_probe').all(); }

describe('에이전트 결과 수신의 원자적 완료', () => {
  it('최종 검사가 실패하면 검사 중 쓰기까지 되돌린다', () => {
    expect(() => queue.completeLeasedResult({ ...completion(), validate: () => {
      database.sqlite.exec('INSERT INTO result_probe VALUES (1)');
      throw new Error('identity changed');
    } })).toThrow('identity changed');
    expect(rows()).toEqual([]);
    expect(queue.getJob('job')?.status).toBe('STARTING');
  });

  it('소유 데이터 검증에서 거부된 결과는 저장하지 않는다', () => {
    const persist = vi.fn();
    expect(queue.completeLeasedResult({ ...completion(), validate: () => '실행 pin 변경', persist })).toBe('IDENTITY_REJECTED');
    expect(persist).not.toHaveBeenCalled();
    expect(queue.getJob('job')).toMatchObject({ status: 'FAILED', error: '실행 pin 변경' });
  });

  it('결과 저장 후 완료 CAS가 실패하면 결과와 상태 변경을 모두 되돌린다', () => {
    expect(() => queue.completeLeasedResult({ ...completion(), persist: () => {
      database.sqlite.exec("INSERT INTO result_probe VALUES (1); UPDATE backtest_jobs SET status = 'CANCELLING'");
    } })).toThrow('job 완료 전이');
    expect(rows()).toEqual([]);
    expect(queue.getJob('job')?.status).toBe('STARTING');
  });

  it('최종 검증부터 완료까지 계산 DB 쓰기를 잠그고 중복 결과를 다시 저장하지 않는다', () => {
    const competing = new Database(database.dataPath, { timeout: 0 });
    try {
      const input = { ...completion(), validate: () => {
        expect(() => competing.exec("INSERT INTO symbols (code, market, created_at_ms) VALUES ('005930', 'KR', 1)")).toThrow(/locked/);
        return null;
      } };
      expect(queue.completeLeasedResult(input)).toBe('ACCEPTED');
      expect(queue.completeLeasedResult(input)).toBe('IDEMPOTENT');
      expect(rows()).toEqual([{ value: 1 }]);
      expect(queue.getJob('job')).toMatchObject({ status: 'COMPLETED', resultChecksum: 'checksum' });
      expect(() => competing.exec("INSERT INTO symbols (code, market, created_at_ms) VALUES ('005930', 'KR', 1)")).not.toThrow();
    } finally { competing.close(); }
  });

  it('이전 시도와 만료된 토큰은 최종 검사 전에 거부한다', () => {
    const validate = vi.fn(() => null);
    expect(queue.completeLeasedResult({ ...completion(), attempt: 2, validate })).toBe('STALE_LEASE');
    expect(queue.completeLeasedResult({ ...completion(), nowMs: 1001, validate })).toBe('STALE_LEASE');
    expect(validate).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
});
