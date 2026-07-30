import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { brokerSyncState, dataCoverage, datasets } from '../../src/server/shared/db/schema.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** `--> statement-breakpoint` 로 나뉜 마이그레이션 SQL 파일 하나를 순서대로 실행한다. */
function applyMigrationFile(sqlite: Database.Database, filePath: string): void {
  const content = readFileSync(filePath, 'utf-8');
  const statements = content
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    sqlite.exec(statement);
  }
}

let dir: string;
let handle: DatabaseHandle;
let db: AppDatabase;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'slice-schema-'));
  handle = openDatabase(join(dir, 'test.sqlite'));
  db = handle.db;
});
afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('슬라이스 스키마', () => {
  it('datasets 에 defaultTimeframe·symbolsKey, coverage·sync_state 에 slice 가 있다', () => {
    db.insert(datasets)
      .values({
        id: 'ds_t', name: 't', market: 'KR', timeframe: '1h',
        defaultTimeframe: '1m', symbolsKey: '005930',
        symbolsJson: '["005930"]', createdAtMs: 1, updatedAtMs: 1,
      })
      .run();
    db.insert(dataCoverage)
      .values({ datasetId: 'ds_t', symbol: '005930', slice: '1m', barCount: 0, computedAtMs: 1 })
      .run();
    db.insert(brokerSyncState).values({ datasetId: 'ds_t', symbol: '005930', slice: '1m' }).run();

    expect(db.select().from(datasets).all()[0]?.defaultTimeframe).toBe('1m');
    expect(db.select().from(dataCoverage).all()[0]?.slice).toBe('1m');
    expect(db.select().from(brokerSyncState).all()[0]?.slice).toBe('1m');
  });

  it('sync_state 는 같은 (dataset, symbol) 에 슬라이스가 다르면 공존한다', () => {
    db.insert(brokerSyncState).values({ datasetId: 'ds_t', symbol: '005930', slice: '1d' }).run();
    expect(db.select().from(brokerSyncState).all()).toHaveLength(2);
  });
});

describe('0004 백필 마이그레이션 (레거시 행)', () => {
  let backfillDir: string;
  let sqlite: Database.Database;

  beforeAll(() => {
    backfillDir = mkdtempSync(join(tmpdir(), 'slice-backfill-'));
    sqlite = new Database(join(backfillDir, 'legacy.sqlite'));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const pre0004 = files.filter((file) => !file.startsWith('0004'));
    for (const file of pre0004) {
      applyMigrationFile(sqlite, join(MIGRATIONS_DIR, file));
    }

    // 0004 이전 스키마 — slice/default_timeframe/symbols_key 컬럼이 아직 없다.
    sqlite.exec(`
      INSERT INTO datasets (id, name, market, timeframe, symbols_json, created_at_ms, updated_at_ms)
      VALUES ('ds_1h', 'legacy-1h', 'KR', '1h', '["005930"]', 1, 1);
      INSERT INTO datasets (id, name, market, timeframe, symbols_json, created_at_ms, updated_at_ms)
      VALUES ('ds_1d', 'legacy-1d', 'KR', '1d', '["005930"]', 1, 1);
      INSERT INTO data_coverage (dataset_id, symbol, bar_count, computed_at_ms)
      VALUES ('ds_1h', '005930', 0, 1);
      INSERT INTO data_coverage (dataset_id, symbol, bar_count, computed_at_ms)
      VALUES ('ds_1d', '005930', 0, 1);
      INSERT INTO broker_sync_state (dataset_id, symbol)
      VALUES ('ds_1h', '005930');
      INSERT INTO broker_sync_state (dataset_id, symbol)
      VALUES ('ds_1d', '005930');
    `);

    const file0004 = files.find((file) => file.startsWith('0004'));
    if (!file0004) throw new Error('0004 마이그레이션 파일을 찾을 수 없습니다');
    applyMigrationFile(sqlite, join(MIGRATIONS_DIR, file0004));
  });

  afterAll(() => {
    sqlite.close();
    rmSync(backfillDir, { recursive: true, force: true });
  });

  it("timeframe '1h' 데이터셋은 default_timeframe·slice 가 '1m' 으로 백필된다", () => {
    const dataset = sqlite
      .prepare('SELECT default_timeframe FROM datasets WHERE id = ?')
      .get('ds_1h') as { default_timeframe: string };
    const coverage = sqlite
      .prepare('SELECT slice FROM data_coverage WHERE dataset_id = ?')
      .get('ds_1h') as { slice: string };
    const sync = sqlite
      .prepare('SELECT slice FROM broker_sync_state WHERE dataset_id = ?')
      .get('ds_1h') as { slice: string };

    expect(dataset.default_timeframe).toBe('1m');
    expect(coverage.slice).toBe('1m');
    expect(sync.slice).toBe('1m');
  });

  it("timeframe '1d' 데이터셋은 default_timeframe·slice 가 '1d' 로 백필된다", () => {
    const dataset = sqlite
      .prepare('SELECT default_timeframe FROM datasets WHERE id = ?')
      .get('ds_1d') as { default_timeframe: string };
    const coverage = sqlite
      .prepare('SELECT slice FROM data_coverage WHERE dataset_id = ?')
      .get('ds_1d') as { slice: string };
    const sync = sqlite
      .prepare('SELECT slice FROM broker_sync_state WHERE dataset_id = ?')
      .get('ds_1d') as { slice: string };

    expect(dataset.default_timeframe).toBe('1d');
    expect(coverage.slice).toBe('1d');
    expect(sync.slice).toBe('1d');
  });
});
