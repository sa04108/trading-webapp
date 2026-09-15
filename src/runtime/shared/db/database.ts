import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import {
  dataDatabasePath,
  datasetIdentity,
  initializeDatabaseIdentity,
  migrateDatabaseRole,
  tableExists,
} from "./database-layout.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  readonly db: AppDatabase;
  readonly sqlite: Database.Database;
  readonly dataPath: string;
  close(): void;
}

export interface DatabaseOpenOptions {
  readonly dataPath?: string;
  readonly dataReadonly?: boolean;
}

/** 운영 DB와 계산 DB를 물리적으로 분리한다. 서버의 조회 연결에는 계산 DB를 data로 연결한다. */
export function openDatabase(
  databasePath: string,
  options: DatabaseOpenOptions = {},
): DatabaseHandle {
  const dataPath = options.dataPath ?? dataDatabasePath(databasePath);
  if (options.dataReadonly && !fs.statSync(dataPath).isFile())
    throw new Error("계산 스냅샷 파일이 없습니다");
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    if (fs.existsSync(`${databasePath}.restore.json`))
      throw new Error(
        "DB 복원이 완료되지 않았습니다. db:restore를 다시 실행하세요.",
      );
  }
  if (
    databasePath !== ":memory:" &&
    !options.dataReadonly &&
    !fs.existsSync(databasePath) &&
    fs.existsSync(dataPath)
  ) {
    throw new Error("계산 DB만 존재합니다. 운영 DB를 백업에서 복원하세요.");
  }
  const sqlite = new Database(databasePath);
  try {
    sqlite.pragma("busy_timeout = 5000");
    if (tableExists(sqlite, "symbols")) {
      throw new Error(
        "지원하지 않는 단일 DB입니다. 분리 전환 릴리스 040ef56의 db:prepare로 이전을 완료하세요.",
      );
    }
    const existing = tableExists(sqlite, "operational_database_state");
    if (
      !existing &&
      !options.dataReadonly &&
      dataPath !== ":memory:" &&
      fs.existsSync(dataPath)
    )
      throw new Error(
        "운영 DB 식별자가 없습니다. 두 DB를 백업에서 함께 복원하세요.",
      );
    const expected = existing
      ? (
          sqlite
            .prepare(
              "SELECT dataset_id AS id FROM operational_database_state WHERE singleton = 1",
            )
            .get() as { id: string } | undefined
        )?.id
      : undefined;
    if (expected && dataPath !== ":memory:" && !fs.existsSync(dataPath)) {
      throw new Error(`운영 DB에 연결된 계산 DB가 없습니다: ${dataPath}`);
    }
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    migrateDatabaseRole(
      sqlite,
      options.dataReadonly ? "agent" : "operations",
      "main",
    );
    if (dataPath !== ":memory:" && !options.dataReadonly)
      fs.mkdirSync(path.dirname(path.resolve(dataPath)), { recursive: true });
    if (options.dataReadonly) {
      // 바인딩이 SQLite URI를 지원하지 않으므로 파일 권한으로 읽기 전용을 보장한다.
      // root처럼 권한을 우회할 수 있는 실행 환경도 스냅샷 쓰기 가능 여부로 거부한다.
      let writable = true;
      try {
        fs.accessSync(dataPath, fs.constants.W_OK);
      } catch {
        writable = false;
      }
      if (writable)
        throw new Error("계산 스냅샷은 쓰기 권한이 없는 파일이어야 합니다");
    }
    sqlite.prepare("ATTACH DATABASE ? AS data").run(dataPath);
    let datasetId: string;
    if (options.dataReadonly) {
      datasetId = datasetIdentity(sqlite).datasetId;
      if (expected && expected !== datasetId)
        throw new Error("작업 DB와 계산 DB의 데이터셋 식별자가 다릅니다");
    } else {
      sqlite.pragma("data.journal_mode = WAL");
      migrateDatabaseRole(sqlite, "data", "data");
      datasetId = initializeDatabaseIdentity(sqlite, "data", expected);
    }
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO operational_database_state (singleton, dataset_id) VALUES (1, ?)",
      )
      .run(datasetId);
    return {
      db: drizzle(sqlite, { schema }),
      sqlite,
      dataPath,
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
