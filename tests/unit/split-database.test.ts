import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { dataDatabasePath, datasetIdentity } from '../../src/server/shared/db/database-layout.js';
import { DATA_TABLE_NAMES, OPERATIONAL_TABLE_NAMES } from '../../src/server/shared/db/database-tables.js';
import { migrateSplitDatabase } from '../../src/server/shared/db/split-database-migration.js';

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-split-db-'));
  file = path.join(directory, 'app.sqlite');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

function legacyDatabase(): void {
  const sqlite = new Database(file);
  try {
    sqlite.exec(fs.readFileSync('migrations/0000_baseline.sql', 'utf8'));
    sqlite.exec(`
      INSERT INTO users (id, username, password_hash, created_at_ms, updated_at_ms)
        VALUES ('user', 'alice', 'private-hash', 1, 1);
      INSERT INTO symbols (code, market, created_at_ms) VALUES ('005930', 'KR', 1);
      INSERT INTO facts (scope, key, field, period_key, as_of_ts_ms, value, unit)
        VALUES ('SYMBOL', '005930', 'NET_INCOME', '2025Q4', 1, 42, 'KRW');
      INSERT INTO backtest_jobs (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json, created_at_ms)
        VALUES ('job', 'COMPLETED', '{}', 'range-breakout', '{}', '[]', 1);
      INSERT INTO external_api_daily_usage (api, quota_scope, usage_date_kst, calls_used, updated_at_ms)
        VALUES ('DART', 'daily', '2026-09-14', 127, 1);
      INSERT INTO audit_logs (id, actor, event, created_at_ms) VALUES (99, 'user', 'retained', 1);
      DELETE FROM audit_logs;
    `);
  } finally { sqlite.close(); }
}

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
        expect(tables(data)).toEqual(expect.arrayContaining([...DATA_TABLE_NAMES, 'dataset_state']));
        expect(tables(data).filter((name) => OPERATIONAL_TABLE_NAMES.includes(name as never))).toEqual([]);
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

describe('기존 단일 DB 이전', () => {
  it('계정·입력·작업·API 원장과 자동 증가 값을 보존하고 반복 실행해도 유지한다', () => {
    legacyDatabase();
    expect(() => openDatabase(file)).toThrow('기존 단일 DB를 분리');
    const result = migrateSplitDatabase(file);
    expect(result.status).toBe('MIGRATED');
    expect(result.backupPath).toBeDefined();
    const backup = new Database(result.backupPath!, { readonly: true });
    try { expect(tables(backup)).toEqual(expect.arrayContaining(['users', 'symbols'])); } finally { backup.close(); }
    const handle = openDatabase(file);
    try {
      expect(handle.sqlite.prepare('SELECT password_hash FROM users').get()).toEqual({ password_hash: 'private-hash' });
      expect(handle.sqlite.prepare('SELECT value FROM facts').get()).toEqual({ value: 42 });
      expect(handle.sqlite.prepare('SELECT id, status FROM backtest_jobs').get()).toEqual({ id: 'job', status: 'COMPLETED' });
      expect(handle.sqlite.prepare('SELECT calls_used FROM external_api_daily_usage').get()).toEqual({ calls_used: 127 });
      handle.sqlite.exec("INSERT INTO audit_logs (actor, event, created_at_ms) VALUES ('user', 'next', 1)");
      expect(handle.sqlite.prepare('SELECT id FROM audit_logs').get()).toEqual({ id: 100 });
    } finally { handle.close(); }
    expect(migrateSplitDatabase(file)).toEqual({ status: 'ALREADY_SPLIT' });
  });

  it.each([1, 2, 3])('파일 활성화 %i 단계에서 중단돼도 기록으로 복구한다', (failAt) => {
    legacyDatabase();
    const rename = fs.renameSync;
    let activated = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!String(to).endsWith('.json') && ++activated === failAt) throw new Error('simulated interruption');
      rename(from, to);
    });
    expect(() => migrateSplitDatabase(file)).toThrow('simulated interruption');
    expect(() => openDatabase(file)).toThrow('DB 분리 작업이 완료되지');
    vi.restoreAllMocks();
    const recovered = migrateSplitDatabase(file);
    expect(recovered.status).toBe('RECOVERED');
    expect(fs.existsSync(recovered.backupPath!)).toBe(true);
    const handle = openDatabase(file);
    try { expect(handle.sqlite.prepare('SELECT value FROM facts').get()).toEqual({ value: 42 }); }
    finally { handle.close(); }
    expect(fs.existsSync(`${file}.split-migration.json`)).toBe(false);
  });

  it('소유 DB가 정의되지 않은 테이블이 있으면 원본을 보존하며 중단한다', () => {
    legacyDatabase();
    const original = new Database(file);
    original.exec('CREATE TABLE unclassified (secret TEXT)');
    original.close();
    expect(() => migrateSplitDatabase(file)).toThrow('소유 DB가 정의되지');
    expect(fs.existsSync(dataDatabasePath(file))).toBe(false);
    const retained = new Database(file, { readonly: true });
    try { expect(retained.prepare('SELECT value FROM facts').get()).toEqual({ value: 42 }); } finally { retained.close(); }
  });

  it('새 DB 준비는 두 파일을 만들고 운영 파일이 유실된 경우 빈 DB를 만들지 않는다', () => {
    expect(migrateSplitDatabase(file)).toEqual({ status: 'NEW' });
    fs.rmSync(file);
    expect(() => openDatabase(file)).toThrow('계산 DB만 존재');
    expect(() => migrateSplitDatabase(file)).toThrow('계산 DB만 존재');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('두 DB의 배포 백업과 복원', () => {
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
  it('분리 배포 실패 후 단일 DB 백업으로 복원하고 분리를 다시 진행할 수 있다', async () => {
    const { backupDatabase, restoreDatabase } = await import('../../src/server/shared/db/database-backup.js');
    legacyDatabase(); const backup = path.join(directory, 'before.sqlite');
    await backupDatabase(file, backup); migrateSplitDatabase(file);
    await restoreDatabase(file, backup);
    expect(fs.existsSync(dataDatabasePath(file))).toBe(false);
    expect(migrateSplitDatabase(file).status).toBe('MIGRATED');
  });
});
