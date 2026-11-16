import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import { migrateDatabaseRole } from '../../src/runtime/shared/db/database-layout.js';

// 신규 DB 검사는 작성 중인 초안과 단일 준비 참조를 여러 위저드로 옮기는 이행을 보호하지 못한다.
it('기존 초안과 준비 참조를 독립 위저드로 옮기고 재기동에도 같은 ID를 유지한다', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)');
    for (const migration of readMigrationFiles({ migrationsFolder: 'migrations/operations' }).slice(0, 20)) {
      for (const statement of migration.sql) sqlite.exec(statement);
      sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis);
    }
    sqlite.exec(`
      INSERT INTO users (id,username,password_hash,created_at_ms,updated_at_ms) VALUES ('owner','owner','test',1,1);
      INSERT INTO backtest_preparation_jobs (id,status,phase,request_hash,request_json,created_at_ms,updated_at_ms)
        VALUES ('preparing','RUNNING','RESOLVING_STAGES','hash','{}',2,3);
      INSERT INTO backtest_wizard_drafts (user_id,context,step,payload_json,updated_at_ms)
        VALUES ('owner','','strategy','{"strategyId":"x","parameters":{},"currentStep":"period"}',2),
        ('owner','clone','strategy','{"strategyId":"y","parameters":{},"currentStep":"universe"}',3);
      INSERT INTO preparation_wizard_references (user_id,context,preparation_job_id) VALUES ('owner','clone','preparing');
    `);
    migrateDatabaseRole(sqlite, 'operations', 'main');
    const rows = sqlite.prepare('SELECT id,source_job_id,current_step,status FROM backtest_wizard_jobs ORDER BY created_at_ms').all() as { id: string; source_job_id: string | null; current_step: string; status: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source_job_id: null, current_step: 'period', status: 'WAITING' });
    expect(rows[1]).toMatchObject({ source_job_id: 'clone', current_step: 'universe', status: 'WAITING' });
    expect(sqlite.prepare('SELECT context FROM backtest_wizard_drafts ORDER BY updated_at_ms').all()).toEqual(rows.map((row) => ({ context: row.id })));
    expect(sqlite.prepare('SELECT context,preparation_job_id FROM preparation_wizard_references').get()).toEqual({ context: rows[1]!.id, preparation_job_id: 'preparing' });
    expect(sqlite.prepare('SELECT wizard_id,kind,job_id FROM backtest_wizard_children').get()).toEqual({ wizard_id: rows[1]!.id, kind: 'preparation', job_id: 'preparing' });
    sqlite.prepare('INSERT INTO preparation_wizard_references (user_id,context,preparation_job_id) VALUES (?,?,?)').run('owner',rows[0]!.id,'preparing');
    migrateDatabaseRole(sqlite, 'operations', 'main');
    expect(sqlite.prepare('SELECT id,source_job_id,current_step,status FROM backtest_wizard_jobs ORDER BY created_at_ms').all()).toEqual(rows);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally { sqlite.close(); }
});

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

// 빈 DB 생성 테스트는 컬럼 삭제 중 기존 결과·대기 작업·새 비교 선택의 손실을 잡지 못한다.
it.each(['operations', 'agent'] as const)('%s DB의 옛 벤치마크 pin을 제거해도 작업과 관련 데이터를 보존한다', (role) => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)');
    // 서버는 비교 선택 테이블 도입 직후, 에이전트는 최초 스키마에서 업그레이드한다.
    const previousCount = role === 'operations' ? 17 : 1;
    for (const migration of readMigrationFiles({ migrationsFolder: `migrations/${role}` }).slice(0, previousCount)) {
      for (const statement of migration.sql) sqlite.exec(statement);
      sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis);
    }
    sqlite.exec(`
      INSERT INTO backtest_jobs (id, status, request_json, strategy_id, universe_rule_json,
        universe_schedule_json, universe_json, universe_hash, provenance_pin_json, benchmark_json, benchmark_hash, created_at_ms)
      VALUES ('source', 'COMPLETED', '{"randomSeed":42}', 'strategy', '{}', '[]', '[]', 'universe-hash', '{}', '{old-pin', 'old-hash', 1),
             ('queued', 'QUEUED', '{"randomSeed":43}', 'strategy', '{}', '[]', '[]', 'universe-hash', '{}', '{old-pin', 'old-hash', 2);
    `);
    const tables = ['backtest_jobs'];
    if (role === 'operations') {
      sqlite.exec(`
        INSERT INTO users (id, username, password_hash, created_at_ms, updated_at_ms)
        VALUES ('user', 'user', 'unused-test-hash', 1, 1);
        INSERT INTO backtest_metrics (job_id, total_return_pct, max_drawdown_pct, trade_count, metrics_json)
        VALUES ('source', 10, -5, 1, '{"totalReturnPct":10}');
        INSERT INTO backtest_equity_points (job_id, ts_ms, equity) VALUES ('source', 1, 110);
        INSERT INTO backtest_clone_batches (id, source_job_id, strategy_id, status, total_count,
          request_json, universe_schedule_json, universe_json, universe_hash, provenance_pin_json,
          benchmark_json, benchmark_hash, created_at_ms)
        VALUES ('batch', 'source', 'strategy', 'ACTIVE', 2, '{}', '[]', '[]', 'universe-hash', '{}', '{old-pin', 'old-hash', 1);
        INSERT INTO backtest_clone_batch_items (id, batch_id, ordinal, random_seed, state, job_id)
        VALUES ('dispatched', 'batch', 0, 43, 'DISPATCHED', 'queued'), ('pending', 'batch', 1, 44, 'PENDING', NULL);
        INSERT INTO backtest_benchmark_selections (user_id, job_id, benchmark_ids_json)
        VALUES ('user', 'source', '["KOSPI","SP500"]');
      `);
      tables.push('backtest_clone_batches', 'backtest_clone_batch_items', 'backtest_metrics', 'backtest_equity_points', 'backtest_benchmark_selections');
    }
    const discarded = ['benchmark_json', 'benchmark_hash'];
    const snapshots = tables.map((table) => {
      const columns = (sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>)
        .map(({ name }) => name).filter((name) => !discarded.includes(name));
      const query = `SELECT ${columns.map((name) => `"${name}"`).join(', ')} FROM ${table} ORDER BY rowid`;
      return { query, rows: sqlite.prepare(query).all() };
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      migrateDatabaseRole(sqlite, role, 'main');
      for (const table of role === 'operations' ? ['backtest_jobs', 'backtest_clone_batches'] : ['backtest_jobs']) {
        const columns = (sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map(({ name }) => name);
        for (const column of discarded) expect(columns).not.toContain(column);
      }
      for (const { query, rows } of snapshots) expect(sqlite.prepare(query).all()).toEqual(rows);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    }
  } finally { sqlite.close(); }
});
