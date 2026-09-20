import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { AgentPreparationQueue } from '../../src/server/modules/agents/application/agent-preparation-queue.js';
import { AgentDataQueue } from '../../src/server/modules/agents/application/agent-data-queue.js';
import type { DatasetSnapshots } from '../../src/server/modules/agents/application/dataset-snapshots.js';
import type { DatasetManifest } from '../../src/shared/agent-protocol.js';

it('동시 파일 DB 쓰기가 끝난 뒤 데이터 요청과 WAITING_DATA 전이를 원자적으로 저장한다', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preparation-lock-'));
  const file = path.join(directory, 'operations.sqlite');
  const database = openDatabase(file);
  let writer: ReturnType<typeof spawn> | undefined;
  try {
    database.sqlite.prepare("INSERT INTO backtest_preparation_jobs (id, request_hash, request_json, status, phase, created_at_ms, updated_at_ms) VALUES ('waiting-job', 'request', '{}', 'QUEUED', 'MARKET_DATA', 1, 1)").run();
    const changed = vi.fn();
    const preparations = new AgentPreparationQueue(database, changed);
    const dataset: DatasetManifest = { version: 1, datasetId: 'fixture', sourceRevision: 0, collectionVersion: 'a'.repeat(64), schemaVersion: 1, sha256: 'b'.repeat(64), bytes: 1 };
    const lease = preparations.claim('client', dataset)!;
    const queue = new AgentDataQueue(database, {} as DatasetSnapshots, vi.fn(), vi.fn(), pino({ enabled: false }));
    const request = () => queue.request('PREPARATION', lease.jobId, 1, { kind: 'MARKET', dates: ['2026-01-05'] });
    // 별도 프로세스가 실제 WAL 쓰기 잠금을 잡아 부모의 동기 SQLite 대기 중에도 해제할 수 있다.
    writer = spawn(process.execPath, ['--input-type=commonjs', '-e', `
      const Database = require(process.argv[2]);
      const db = new Database(process.argv[1]);
      db.pragma('busy_timeout = 5000');
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE backtest_preparation_jobs SET updated_at_ms = 2 WHERE id = 'waiting-job'").run();
      process.stdout.write('LOCKED\\n');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 200);
    `, file, createRequire(import.meta.url).resolve('better-sqlite3')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(writer, 'exit');
    expect(String((await once(writer.stdout!, 'data'))[0])).toContain('LOCKED');
    // 기존 deferred 읽기→쓰기 승격은 busy_timeout을 기다리지 못하고 즉시 실패한다.
    expect(() => database.sqlite.transaction(request)()).toThrow(/locked/);
    expect(database.sqlite.prepare('SELECT * FROM agent_data_requests').all()).toEqual([]);
    expect(preparations.waitForData('client', lease, request)).toBe(true);
    expect(database.sqlite.prepare('SELECT status FROM backtest_preparation_jobs WHERE id = ?').get(lease.jobId)).toEqual({ status: 'WAITING_DATA' });
    expect(database.sqlite.prepare('SELECT status FROM agent_data_requests').all()).toEqual([{ status: 'QUEUED' }]);
    expect(database.sqlite.prepare('SELECT job_id FROM agent_data_waits').all()).toEqual([{ job_id: lease.jobId }]);
    expect(database.sqlite.prepare('SELECT lease_token_hash, lease_expires_at_ms FROM agent_preparation_leases WHERE job_id = ?').get(lease.jobId)).toEqual({ lease_token_hash: null, lease_expires_at_ms: null });
    expect(await exited).toEqual([0, null]);
    const duplicate = vi.fn();
    expect(preparations.waitForData('client', lease, duplicate)).toBe(false);
    expect(duplicate).not.toHaveBeenCalled();
    await queue.stop();
  } finally {
    if (writer && writer.exitCode === null) writer.kill();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
