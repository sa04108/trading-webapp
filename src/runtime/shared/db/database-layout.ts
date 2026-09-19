import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type Database from "better-sqlite3";

export const DATABASE_SCHEMA_VERSION = 3;
export type DatabaseRole = "operations" | "data" | "agent";
export const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../../migrations/", import.meta.url),
);

export function dataDatabasePath(operationsPath: string): string {
  if (operationsPath === ":memory:") return ":memory:";
  const extension = path.extname(operationsPath);
  return extension
    ? `${operationsPath.slice(0, -extension.length)}.data${extension}`
    : `${operationsPath}.data.sqlite`;
}

export function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** 마이그레이션의 최상위 객체만 대상 DB로 지정한다. 트리거 본문은 같은 DB를 참조한다. */
function qualifyMigration(statement: string, namespace: string): string {
  let sql = statement.trim();
  for (;;) {
    const next = sql.replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*/, "");
    if (next === sql) break;
    sql = next;
  }
  if (!sql) return "";
  const prefix =
    /^(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+(?:IF NOT EXISTS\s+)?|(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP (?:TABLE|INDEX|TRIGGER)(?: IF EXISTS)?)\s+)/i;
  if (!prefix.test(sql))
    throw new Error(`지원하지 않는 DB 마이그레이션 문장: ${sql.slice(0, 70)}`);
  return sql.replace(prefix, `$1${sqlIdentifier(namespace)}.`);
}

export function tableExists(
  sqlite: Database.Database,
  table: string,
  namespace = "main",
): boolean {
  return (
    sqlite
      .prepare(
        `SELECT 1 FROM ${sqlIdentifier(namespace)}.sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(table) !== undefined
  );
}

/** 각 파일은 독립된 마이그레이션 이력을 가진다. 다른 파일의 DDL을 실행하지 않는다. */
export function migrateDatabaseRole(
  sqlite: Database.Database,
  role: DatabaseRole,
  namespace: string,
): void {
  const directory = path.join(MIGRATIONS_DIRECTORY, role);
  if (!fs.existsSync(directory))
    throw new Error(`DB 마이그레이션 폴더가 없습니다: ${directory}`);
  const identifier = `${sqlIdentifier(namespace)}.__drizzle_migrations`;
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${identifier} (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)`,
  );
  const current = sqlite
    .prepare(
      `SELECT created_at FROM ${identifier} ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { created_at: number } | undefined;
  for (const migration of readMigrationFiles({ migrationsFolder: directory })) {
    if (current && Number(current.created_at) >= migration.folderMillis)
      continue;
    sqlite.transaction(() => {
      for (const statement of migration.sql) {
        const sql = qualifyMigration(statement, namespace);
        if (sql) sqlite.exec(sql);
      }
      sqlite
        .prepare(`INSERT INTO ${identifier} (hash, created_at) VALUES (?, ?)`)
        .run(migration.hash, migration.folderMillis);
    })();
  }
}

export function datasetIdentity(
  sqlite: Database.Database,
  namespace = "data",
): { datasetId: string; revision: number } {
  const row = sqlite
    .prepare(
      `SELECT dataset_id AS datasetId, revision FROM ${sqlIdentifier(namespace)}.dataset_state WHERE singleton = 1`,
    )
    .get() as { datasetId: string; revision: number } | undefined;
  if (!row) throw new Error("계산 DB의 데이터셋 식별자가 없습니다");
  return row;
}

export function initializeDatabaseIdentity(
  sqlite: Database.Database,
  namespace = "data",
  expectedDatasetId?: string,
): string {
  const existing = sqlite
    .prepare(
      `SELECT dataset_id AS datasetId FROM ${sqlIdentifier(namespace)}.dataset_state WHERE singleton = 1`,
    )
    .get() as { datasetId: string } | undefined;
  const datasetId = existing?.datasetId ?? expectedDatasetId ?? randomUUID();
  if (expectedDatasetId && datasetId !== expectedDatasetId)
    throw new Error("운영 DB와 계산 DB의 데이터셋 식별자가 다릅니다");
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO ${sqlIdentifier(namespace)}.dataset_state (singleton, dataset_id, revision) VALUES (1, ?, 0)`,
    )
    .run(datasetId);
  const actual = datasetIdentity(sqlite, namespace).datasetId;
  if (expectedDatasetId && actual !== expectedDatasetId)
    throw new Error("운영 DB와 계산 DB의 데이터셋 식별자가 다릅니다");
  return actual;
}
