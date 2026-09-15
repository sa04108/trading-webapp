import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import { migrateDatabaseRole } from '../../src/runtime/shared/db/database-layout.js';

describe('실행·검증 버전 DB 이행', () => {
  it('기존 결과와 실험의 출처를 보존하고 알 수 없는 도메인 버전은 NULL로 남긴다', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-domain-migration-'));
    const sqlite = new Database(path.join(directory, 'app.sqlite'));
    try {
      sqlite.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)');
      for (const migration of readMigrationFiles({ migrationsFolder: 'migrations/operations' }).slice(0, 5)) {
        for (const statement of migration.sql) sqlite.exec(statement);
        sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis);
      }
      sqlite.exec(`
        INSERT INTO backtest_jobs (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json, created_at_ms)
        VALUES ('source', 'COMPLETED', '{}', 'strategy', '{}', '[]', 1);
        INSERT INTO backtest_runs (id, job_id, strategy_id, strategy_version, strategy_source_hash,
          parameter_json, universe_rule_json, schedule_hash, universe_hash, universe_json, engine_version,
          fee_model_version, slippage_model_version, random_seed, git_commit_sha, started_at_ms)
        VALUES ('run', 'source', 'strategy', '1', 'source-hash', '{}', '{}', 'schedule', 'universe', '[]',
          'engine', 'fee', 'slippage', 42, 'historical-sha', 1);
        INSERT INTO backtest_validations (id, source_job_id, request_json, config_json, plan_json,
          strategy_version, strategy_source_hash, engine_version, git_commit_sha, status, created_at_ms)
        VALUES ('validation', 'source', '{}', '{}', '{}', '1', 'source-hash', 'engine', 'historical-sha', 'ACTIVE', 1);
      `);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        migrateDatabaseRole(sqlite, 'operations', 'main');
        expect(sqlite.prepare('SELECT id, git_commit_sha, execution_version FROM backtest_runs').all()).toEqual([
          { id: 'run', git_commit_sha: 'historical-sha', execution_version: null },
        ]);
        expect(sqlite.prepare('SELECT id, git_commit_sha, execution_version, validation_version, status FROM backtest_validations').all()).toEqual([
          { id: 'validation', git_commit_sha: 'historical-sha', execution_version: null, validation_version: null, status: 'ACTIVE' },
        ]);
      }
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

it('수집 coverage 컬럼 이행은 기존 시장 데이터를 보존하고 버전만 미확정으로 남긴다', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)');
    for (const migration of readMigrationFiles({ migrationsFolder: 'migrations/data' }).slice(0, 2)) {
      for (const statement of migration.sql) sqlite.exec(statement);
      sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis);
    }
    sqlite.exec(`
      INSERT INTO symbol_master_coverage (start_date, end_date, synced_at_ms) VALUES ('2026-01-05', '2026-01-06', 1);
      INSERT INTO krx_non_trading_coverage (start_date, end_date, synced_at_ms) VALUES ('2026-01-05', '2026-01-06', 1);
      INSERT INTO daily_selection_metric_coverage (date, synced_at_ms) VALUES ('2026-01-05', 1);
      INSERT INTO krx_daily_bars (short_code, date, market, open, high, low, close, volume)
      VALUES ('005930', '2026-01-05', 'KOSPI', 100, 110, 90, 105, 10);
    `);
    const bars = sqlite.prepare('SELECT * FROM krx_daily_bars').all();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      migrateDatabaseRole(sqlite, 'data', 'main');
      expect(sqlite.prepare('SELECT * FROM krx_daily_bars').all()).toEqual(bars);
      for (const table of ['symbol_master_coverage', 'krx_non_trading_coverage', 'daily_selection_metric_coverage']) {
        expect(sqlite.prepare(`SELECT collection_version FROM ${table}`).all()).toEqual([{ collection_version: null }]);
      }
    }
  } finally { sqlite.close(); }
});
