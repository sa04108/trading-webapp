import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { factStorageState } from '../../src/server/shared/db/schema.js';
import { DuckDbService } from '../../src/server/modules/market-data/infrastructure/duckdb-service.js';
import { migrateParquetFacts } from '../../src/server/modules/facts/infrastructure/parquet-fact-migration.js';
import { ParquetFactRepository } from '../../src/server/modules/facts/infrastructure/parquet-fact-repository.js';
import { SqliteFactRepository } from '../../src/server/modules/facts/infrastructure/sqlite-fact-repository.js';

let root: string | null = null;
let database: DatabaseHandle | null = null;

afterEach(() => {
  database?.close();
  database = null;
  if (root !== null) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('Parquet fact migration', () => {
  it('기존 팩트를 검증해 SQLite로 옮기고 원본은 남긴다', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-migration-'));
    const dataRoot = path.join(root, 'market-data');
    const duckdb = new DuckDbService({ threads: 1, memoryLimit: '256MB' });
    const source = new ParquetFactRepository(dataRoot, duckdb);
    await source.saveFacts([
      {
        scope: 'SYMBOL', key: '005930', field: 'NET_INCOME', periodKey: '2025Q1',
        asOfTsMs: 1_000, value: 10, unit: 'KRW',
      },
      {
        scope: 'MACRO', key: 'KR_BASE_RATE', field: 'RATE', periodKey: '2025-01-01',
        asOfTsMs: 2_000, value: 2.5, unit: 'PERCENT',
      },
    ]);
    await source.ensurePartition('SYMBOL', '000660');
    duckdb.close();

    database = openDatabase(path.join(root, 'app.sqlite'));
    const first = await migrateParquetFacts(
      database.db,
      dataRoot,
      { threads: 1, memoryLimit: '256MB' },
      3_000,
    );
    const target = new SqliteFactRepository(database.db);

    expect(first).toEqual({ migrated: true, symbols: 2, rows: 2 });
    expect(await target.getFacts({ scope: 'SYMBOL' })).toHaveLength(1);
    expect(await target.getFacts({ scope: 'MACRO' })).toHaveLength(1);
    expect(database.db.select().from(factStorageState).get()).toMatchObject({
      singleton: 1,
      phase: 'ACTIVE',
      migratedAtMs: 3_000,
    });
    expect(fs.existsSync(path.join(dataRoot, 'facts', 'scope=SYMBOL', 'symbol=005930', 'data.parquet')))
      .toBe(true);

    await expect(migrateParquetFacts(
      database.db,
      dataRoot,
      { threads: 1, memoryLimit: '256MB' },
    )).resolves.toEqual({ migrated: false, symbols: 0, rows: 0 });
  });
});
