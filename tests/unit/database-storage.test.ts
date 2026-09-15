import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { dataDatabasePath, datasetIdentity, initializeDatabaseIdentity, migrateDatabaseRole } from '../../src/runtime/shared/db/database-layout.js';
import { DATA_TABLE_NAMES } from '../../src/server/shared/db/database-tables.js';

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-split-db-'));
  file = path.join(directory, 'app.sqlite');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

function tables(sqlite: Database.Database): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name);
}

describe('물리 DB 분리', () => {
  it('계산 DB에는 입력 데이터만 있으며 서버 연결은 두 파일을 조회한다', () => {
    const handle = openDatabase(file);
    try {
      handle.sqlite.exec("INSERT INTO symbols (code, market, created_at_ms) VALUES ('005930', 'KR', 1)");
      const data = new Database(handle.dataPath, { readonly: true });
      try {
        expect(tables(data).sort()).toEqual([...DATA_TABLE_NAMES, 'dataset_state', '__drizzle_migrations', 'sqlite_sequence'].sort());
        expect(tables(handle.sqlite).filter((name) => DATA_TABLE_NAMES.includes(name as never))).toEqual([]);
        expect(data.prepare('SELECT code FROM symbols').all()).toEqual([{ code: '005930' }]);
      } finally { data.close(); }
      expect(datasetIdentity(handle.sqlite).revision).toBeGreaterThan(0);
      const revision = datasetIdentity(handle.sqlite).revision;
      handle.sqlite.exec("INSERT INTO audit_logs (actor, event, created_at_ms) VALUES ('user', 'test', 1)");
      expect(datasetIdentity(handle.sqlite).revision).toBe(revision);
      expect(() => handle.sqlite.transaction(() => {
        handle.sqlite.exec("UPDATE symbols SET name = 'rollback'");
        throw new Error('rollback');
      })()).toThrow('rollback');
      expect(datasetIdentity(handle.sqlite).revision).toBe(revision);
    } finally { handle.close(); }
  });

  it('스냅샷은 읽기 전용으로 연결하고 작업 상태는 별도 파일에 기록한다', () => {
    openDatabase(file).close();
    fs.chmodSync(dataDatabasePath(file), 0o444);
    const job = openDatabase(path.join(directory, 'job.sqlite'), { dataPath: dataDatabasePath(file), dataReadonly: true });
    try {
      expect(() => job.sqlite.exec("INSERT INTO symbols (code, market, created_at_ms) VALUES ('1', 'KR', 1)")).toThrow(/readonly/);
      job.sqlite.transaction(() => job.sqlite.exec("INSERT INTO audit_logs (actor, event, created_at_ms) VALUES ('agent', 'job', 1)"))();
      expect(job.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).toEqual({ n: 1 });
    } finally { job.close(); }
  });

  it('운영 파일만 유실됐으면 빈 DB를 만들지 않는다', () => {
    openDatabase(file).close();
    fs.rmSync(file);
    expect(() => openDatabase(file)).toThrow('계산 DB만 존재');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('단일 DB는 변환 지원 릴리스로 안내하고 원본을 수정하지 않는다', () => {
    const legacy = new Database(file);
    legacy.exec("CREATE TABLE symbols (code TEXT); INSERT INTO symbols VALUES ('005930')");
    legacy.close();
    expect(() => openDatabase(file)).toThrow('040ef56');
    const retained = new Database(file, { readonly: true });
    try { expect(tables(retained)).toEqual(['symbols']); } finally { retained.close(); }
    expect(fs.existsSync(dataDatabasePath(file))).toBe(false);
  });

  it('계산 DB가 사라지거나 다른 데이터셋 파일로 바뀌면 부팅을 거부한다', () => {
    openDatabase(file).close();
    const dataPath = dataDatabasePath(file);
    fs.renameSync(dataPath, `${dataPath}.saved`);
    expect(() => openDatabase(file)).toThrow('계산 DB가 없습니다');
    const other = path.join(directory, 'other.sqlite');
    openDatabase(other).close();
    fs.copyFileSync(dataDatabasePath(other), dataPath);
    expect(() => openDatabase(file)).toThrow('식별자가 다릅니다');
  });
});

describe('두 DB의 배포 백업과 복원', () => {
  it('계산 파일 없는 백업 명세는 운영 파일을 교체하기 전에 거부한다', async () => {
    const { backupDatabase, restoreDatabase } = await import('../../src/server/shared/db/database-backup.js');
    const backup = path.join(directory, 'before.sqlite');
    openDatabase(file).close();
    await backupDatabase(file, backup);
    const before = fs.readFileSync(file);
    const manifest = JSON.parse(fs.readFileSync(`${backup}.json`, 'utf8'));
    fs.writeFileSync(`${backup}.json`, JSON.stringify({ ...manifest, dataSha256: null }));
    await expect(restoreDatabase(file, backup)).rejects.toThrow('백업 명세');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(`${file}.restore.json`)).toBe(false);
  });

  it.each(['data', 'operations'])('%s 파일 교체 중 복원이 중단되면 앱 부팅을 막고 같은 명령으로 복구한다', async (phase) => {
    const { backupDatabase, restoreDatabase } = await import('../../src/server/shared/db/database-backup.js');
    const backup = path.join(directory, 'before.sqlite');
    const handle = openDatabase(file);
    handle.sqlite.exec("INSERT INTO symbols (code, market, created_at_ms) VALUES ('005930', 'KR', 1)");
    handle.close();
    await backupDatabase(file, backup);
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === (phase === 'data' ? dataDatabasePath(file) : file)) throw new Error('복원 중단');
      rename(from, to);
    });
    await expect(restoreDatabase(file, backup)).rejects.toThrow('복원 중단');
    expect(() => openDatabase(file)).toThrow('DB 복원이 완료되지');
    vi.restoreAllMocks();
    await restoreDatabase(file, backup);
    const restored = openDatabase(file);
    try { expect(restored.sqlite.prepare('SELECT code FROM symbols').get()).toEqual({ code: '005930' }); }
    finally { restored.close(); }
  });
  it('두 파일을 함께 복원하고 일부 백업 손상 시 운영 파일을 바꾸지 않는다', async () => {
    const { backupDatabase, restoreDatabase } = await import('../../src/server/shared/db/database-backup.js');
    const backup = path.join(directory, 'backup.sqlite');
    let handle = openDatabase(file);
    handle.sqlite.exec("INSERT INTO symbols (code, market, created_at_ms) VALUES ('005930', 'KR', 1)");
    handle.close();
    await backupDatabase(file, backup);
    handle = openDatabase(file); handle.sqlite.exec('DELETE FROM symbols'); handle.close();
    await restoreDatabase(file, backup);
    handle = openDatabase(file);
    expect(handle.sqlite.prepare('SELECT code FROM symbols').all()).toEqual([{ code: '005930' }]); handle.close();
    fs.appendFileSync(`${backup}.data`, 'corrupt');
    await expect(restoreDatabase(file, backup)).rejects.toThrow('해시');
    handle = openDatabase(file);
    expect(handle.sqlite.prepare('SELECT code FROM symbols').all()).toEqual([{ code: '005930' }]); handle.close();
  });

});

describe('기존 분리 DB의 에이전트 소유권 이행', () => {
  it('활성 임대·완료 결과·소유자 없는 작업을 보존하고 반복 실행해도 ID를 다시 자르지 않는다', () => {
    const data = new Database(dataDatabasePath(file));
    migrateDatabaseRole(data, 'data', 'main');
    const datasetId = initializeDatabaseIdentity(data, 'main');
    data.close();
    const previous = new Database(file);
    previous.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)');
    for (const migration of readMigrationFiles({ migrationsFolder: 'migrations/operations' }).slice(0, 4)) {
      for (const sql of migration.sql) previous.exec(sql);
      previous.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis);
    }
    previous.prepare('INSERT INTO operational_database_state (singleton, dataset_id) VALUES (1, ?)').run(datasetId);
    const insert = previous.prepare(`INSERT INTO backtest_jobs
      (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json, created_at_ms,
       worker_id, attempt, lease_token_hash, lease_expires_at_ms, result_checksum, result_schema_version)
      VALUES (?, ?, '{}', 'test', '{}', '[]', 1, ?, 2, 'token-hash', 9999999999999, 'checksum', 1)`);
    insert.run('active', 'RUNNING', 'remote:agent-a');
    insert.run('local', 'STARTING', 'remote:server-local');
    insert.run('completed', 'COMPLETED', 'remote:remote:historical-id');
    insert.run('queued', 'QUEUED', null);
    previous.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const handle = openDatabase(file);
      try {
        expect(handle.sqlite.prepare('SELECT id, agent_id FROM backtest_jobs ORDER BY id').all()).toEqual([
          { id: 'active', agent_id: 'agent-a' }, { id: 'completed', agent_id: 'remote:historical-id' },
          { id: 'local', agent_id: 'server-local' }, { id: 'queued', agent_id: null },
        ]);
        expect(handle.sqlite.prepare("SELECT status, attempt, lease_token_hash, lease_expires_at_ms, result_checksum, result_schema_version FROM backtest_jobs WHERE id = 'active'").get()).toEqual({
          status: 'RUNNING', attempt: 2, lease_token_hash: 'token-hash', lease_expires_at_ms: 9999999999999,
          result_checksum: 'checksum', result_schema_version: 1,
        });
        expect((handle.sqlite.pragma('table_info(backtest_jobs)') as Array<{ name: string }>).map(({ name }) => name)).not.toContain('worker_id');
      } finally { handle.close(); }
    }
  });
});
