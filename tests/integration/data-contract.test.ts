import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { datasetIdentity, migrateDatabaseRole } from '../../src/runtime/shared/db/database-layout.js';

const directories: string[] = [];
const legacyTables = ['symbol_master_checkpoints', 'symbol_master_checkpoint_symbols', 'symbol_master_events', 'symbol_master_storage_state'];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function previousDatabase(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-data-contract-'));
  directories.push(directory);
  const file = path.join(directory, 'data.sqlite');
  const database = new Database(file);
  try {
    const baseline = readMigrationFiles({ migrationsFolder: 'migrations/data' })[0]!;
    database.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)');
    for (const statement of baseline.sql) database.exec(statement);
    database.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(baseline.hash, baseline.folderMillis);
    database.exec(`
      INSERT INTO dataset_state (singleton, dataset_id, revision) VALUES (1, 'retained-dataset', 10);
      INSERT INTO symbols (code, market, created_at_ms) VALUES ('005930', 'KR', 1);
      INSERT INTO symbol_facts_state (code, covered_years_json, updated_at_ms, financial_updated_at_ms, action_updated_at_ms)
        VALUES ('005930', '[2025]', 999, 100, 200);
      INSERT INTO symbol_master_versions (standard_code, valid_from_date, short_code, name, market, shares_outstanding, instrument_type, recorded_at_ms)
        VALUES ('KR7005930003', '2025-01-02', '005930', '삼성전자', 'KOSPI', '5969782550', 'COMMON_STOCK', 1);
      INSERT INTO symbol_master_trading_days (date) VALUES ('2025-01-02');
      UPDATE symbol_master_storage_state SET phase = 'ACTIVE';
    `);
  } finally { database.close(); }
  return file;
}

describe('완료된 데이터 변환 구조 정리', () => {
  it.each(['main', 'data'])('%s 연결에서 현재 종목 이력·watermark·식별자를 보존하고 스냅샷 revision을 한 번 올린다', (namespace) => {
    const file = previousDatabase();
    const database = new Database(namespace === 'main' ? file : ':memory:');
    if (namespace === 'data') database.prepare('ATTACH DATABASE ? AS data').run(file);
    try {
      const before = datasetIdentity(database, namespace);
      const versions = database.prepare('SELECT * FROM symbol_master_versions').all();
      migrateDatabaseRole(database, 'data', namespace);
      expect(datasetIdentity(database, namespace)).toEqual({ datasetId: before.datasetId, revision: before.revision + 1 });
      expect(database.prepare('SELECT * FROM symbol_master_versions').all()).toEqual(versions);
      expect(database.prepare('SELECT * FROM symbol_facts_state').get()).toMatchObject({
        code: '005930', covered_years_json: '[2025]', financial_updated_at_ms: 100, action_updated_at_ms: 200,
      });
      expect((database.pragma(`${namespace}.table_info(symbol_facts_state)`) as Array<{ name: string }>).map((row) => row.name)).not.toContain('updated_at_ms');
      const tables = database.prepare(`SELECT name FROM ${namespace}.sqlite_master WHERE type='table'`).pluck().all();
      for (const table of legacyTables) expect(tables).not.toContain(table);
      expect(tables).not.toContain('_completed_conversion_guard');
      migrateDatabaseRole(database, 'data', namespace);
      expect(datasetIdentity(database, namespace).revision).toBe(before.revision + 1);
      expect(database.pragma(`${namespace}.foreign_key_check`)).toEqual([]);
    } finally { database.close(); }
  });

  it.each(['checkpoint', 'event', 'pending'])('%s 미변환 상태가 남으면 테이블과 이력을 삭제하지 않는다', (state) => {
    const database = new Database(previousDatabase());
    try {
      if (state === 'checkpoint') database.exec(`
        INSERT INTO symbol_master_checkpoints (id, checkpoint_date, source, created_at_ms) VALUES ('old', '2025-01-02', 'KRX', 1);
        INSERT INTO symbol_master_checkpoint_symbols (checkpoint_id, standard_code, short_code, name, market, shares_outstanding, instrument_type)
          VALUES ('old', 'KR7005930003', '005930', '삼성전자', 'KOSPI', '10', 'COMMON_STOCK');
      `);
      if (state === 'event') database.exec(`INSERT INTO symbol_master_events (effective_date, standard_code, event_type, observed_span_start, created_at_ms)
        VALUES ('2025-01-03', 'KR7005930003', 'DELISTED', '2025-01-02', 1)`);
      if (state === 'pending') database.exec("UPDATE symbol_master_storage_state SET phase = 'PENDING'");
      const before = datasetIdentity(database, 'main');
      const snapshots = [...legacyTables, 'symbol_master_versions', 'symbol_facts_state', '__drizzle_migrations']
        .map((table) => ({ table, rows: database.prepare(`SELECT * FROM ${table}`).all() }));
      expect(() => migrateDatabaseRole(database, 'data', 'main')).toThrow('symbol_master_conversion_required');
      expect(datasetIdentity(database, 'main')).toEqual(before);
      for (const { table, rows } of snapshots) expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
    } finally { database.close(); }
  });
});
