import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// cwd 가 아니라 산출물 기준으로 해석한다:
// src/server/shared/db → <repo>/migrations, dist/server/shared/db → <release>/migrations
const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

/** 스펙 §12 SQLite 설정으로 DB 를 열고 마이그레이션을 적용한다. */
export function openDatabase(databasePath: string): DatabaseHandle {
  // 마이그레이션 없이 빈 스키마로 부팅하면 나중에 알 수 없는 쿼리 에러로 터진다 — 즉시 실패
  if (!fs.existsSync(MIGRATIONS_FOLDER)) {
    throw new Error(
      `migrations 폴더를 찾을 수 없습니다: ${MIGRATIONS_FOLDER} — 배포 산출물에 migrations/ 가 포함됐는지 확인하세요`,
    );
  }

  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
