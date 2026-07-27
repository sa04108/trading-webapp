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

/** 에러와 그 cause 사슬 전체에서 패턴을 찾는다. 순환 참조에 대비해 깊이를 제한한다. */
function hasCauseMatching(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    if (pattern.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

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
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (error) {
    // drizzle 은 journal 항목의 folderMillis 가 __drizzle_migrations 의 최신
    // created_at 보다 크면 그 항목을 적용한다. 배포 전 스쿼시로 0000 의 when 이
    // 바뀌면 이미 그 스키마를 가진 DB 에 전체가 재실행되고 "already exists" 로
    // 죽는다 — 원문 에러만으로는 원인이 전혀 드러나지 않으므로 여기서 설명한다.
    // drizzle 은 원인을 message 가 아니라 cause 사슬에 담는다 ("Failed to run the
    // query ..." 만 위로 올라온다) — 사슬 전체를 훑지 않으면 이 판정이 항상 거짓이 된다.
    if (hasCauseMatching(error, /already exists/i)) {
      throw new Error(
        `마이그레이션이 기존 스키마와 충돌합니다 — 이 DB 는 지금 migrations/ 이력보다 ` +
          `앞선 스키마로 만들어졌습니다. 배포 전 0000 스쿼시가 있었다면 개발용 DB 를 ` +
          `지우고 다시 만드세요: ${databasePath}`,
        { cause: error },
      );
    }
    throw error;
  }

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
