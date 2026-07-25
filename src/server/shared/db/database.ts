import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  readonly db: AppDatabase;
  readonly sqlite: Database.Database;
  close(): void;
}

/** 스펙 §12 SQLite 설정으로 DB 를 열고 마이그레이션을 적용한다. */
export function openDatabase(
  databasePath: string,
  migrationsFolder = path.resolve(process.cwd(), 'migrations'),
): DatabaseHandle {
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });

  if (fs.existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
  }

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
