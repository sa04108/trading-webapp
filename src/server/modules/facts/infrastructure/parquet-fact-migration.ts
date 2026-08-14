import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { factStorageState } from '../../../shared/db/schema.js';
import { factsFingerprint } from '../application/fact-sync-service.js';
import { DuckDbService, type DuckDbOptions } from '../../market-data/infrastructure/duckdb-service.js';
import { ParquetFactRepository } from './parquet-fact-repository.js';
import { SqliteFactRepository } from './sqlite-fact-repository.js';

export interface ParquetFactMigrationResult {
  readonly migrated: boolean;
  readonly symbols: number;
  readonly rows: number;
}

/** 기존 종목별 Parquet을 SQLite에 멱등 이관한다. 성공 전에는 원본을 건드리지 않는다. */
export async function migrateParquetFacts(
  db: AppDatabase,
  dataRoot: string,
  duckdbOptions: DuckDbOptions,
  nowMs = Date.now(),
): Promise<ParquetFactMigrationResult> {
  const state = db.select().from(factStorageState).where(eq(factStorageState.singleton, 1)).get();
  if (state?.phase === 'ACTIVE') return { migrated: false, symbols: 0, rows: 0 };

  db.insert(factStorageState)
    .values({ singleton: 1, phase: 'PENDING', migratedAtMs: null })
    .onConflictDoNothing()
    .run();

  const legacyRoot = path.join(dataRoot, 'facts');
  if (!fs.existsSync(legacyRoot)) {
    markActive(db, nowMs);
    return { migrated: true, symbols: 0, rows: 0 };
  }

  const duckdb = new DuckDbService(duckdbOptions);
  const source = new ParquetFactRepository(dataRoot, duckdb);
  const target = new SqliteFactRepository(db);
  let rows = 0;
  const symbols = [...source.symbolsWithFacts()].sort();

  try {
    for (const symbol of symbols) {
      const incoming = await source.getFacts({ scope: 'SYMBOL', keys: [symbol] });
      await target.saveFacts(incoming);
      await verifyPartition(target, 'SYMBOL', incoming, [symbol]);
      rows += incoming.length;
    }

    const macro = await source.getFacts({ scope: 'MACRO' });
    await target.saveFacts(macro);
    await verifyPartition(target, 'MACRO', macro);
    rows += macro.length;

    markActive(db, nowMs);
    return { migrated: true, symbols: symbols.length, rows };
  } finally {
    duckdb.close();
  }
}

async function verifyPartition(
  target: SqliteFactRepository,
  scope: 'SYMBOL' | 'MACRO',
  expected: Parameters<typeof factsFingerprint>[0],
  keys?: readonly string[],
): Promise<void> {
  const actual = await target.getFacts({ scope, keys });
  if (actual.length !== expected.length || factsFingerprint(actual) !== factsFingerprint(expected)) {
    throw new Error(
      `Parquet 팩트 SQLite 이관 검증 실패: scope=${scope}, `
        + `key=${keys?.join(',') ?? '*'}, expected=${expected.length}, actual=${actual.length}`,
    );
  }
}

function markActive(db: AppDatabase, nowMs: number): void {
  db.update(factStorageState)
    .set({ phase: 'ACTIVE', migratedAtMs: nowMs })
    .where(eq(factStorageState.singleton, 1))
    .run();
}
