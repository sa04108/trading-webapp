import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  DATABASE_SCHEMA_VERSION,
  datasetIdentity,
} from "../runtime/shared/db/database-layout.js";
import { DATA_TABLE_NAMES } from "../server/shared/db/database-tables.js";
import type { DatasetManifest } from "../shared/agent-protocol.js";

function syncFile(file: string): void {
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  syncFile(temporary);
  fs.renameSync(temporary, file);
}

process.once(
  "message",
  (input: {
    sourcePath: string;
    directory: string;
    version: number;
    collectionVersion: string;
  }) => {
    void publish(input)
      .then((manifest) => {
        process.send?.(manifest, () => process.disconnect());
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        if (process.connected) process.disconnect();
      });
  },
);
process.once("disconnect", () => {
  if (process.exitCode === undefined) process.exitCode = 0;
});

async function publish(input: {
  sourcePath: string;
  directory: string;
  version: number;
  collectionVersion: string;
}): Promise<DatasetManifest> {
  const temporary = path.join(
    input.directory,
    `.${input.version}-${randomUUID()}.sqlite`,
  );
  const source = new Database(input.sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await source.backup(temporary);
  } finally {
    source.close();
  }
  try {
    const snapshot = new Database(temporary, { fileMustExist: true });
    let identity: ReturnType<typeof datasetIdentity>;
    try {
      snapshot.pragma("journal_mode = DELETE");
      const allowed = new Set<string>([
        ...DATA_TABLE_NAMES,
        "dataset_state",
        "__drizzle_migrations",
        "sqlite_sequence",
      ]);
      const tables = snapshot
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      if (tables.some(({ name }) => !allowed.has(name)))
        throw new Error("배포할 수 없는 운영 테이블이 계산 DB에 있습니다");
      if (snapshot.pragma("quick_check", { simple: true }) !== "ok")
        throw new Error("계산 DB 무결성 검사 실패");
      identity = datasetIdentity(snapshot, "main");
    } finally {
      snapshot.close();
    }
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(temporary))
      hash.update(chunk);
    const manifest: DatasetManifest = {
      version: input.version,
      datasetId: identity.datasetId,
      sourceRevision: identity.revision,
      collectionVersion: input.collectionVersion,
      schemaVersion: DATABASE_SCHEMA_VERSION,
      sha256: hash.digest("hex"),
      bytes: fs.statSync(temporary).size,
    };
    fs.chmodSync(temporary, 0o444);
    syncFile(temporary);
    fs.renameSync(
      temporary,
      path.join(
        input.directory,
        `${manifest.version}-${manifest.sha256}.sqlite`,
      ),
    );
    writeJson(path.join(input.directory, `${manifest.version}.json`), manifest);
    // 내용 파일과 버전별 명세를 먼저 게시하고 마지막에 최신 포인터를 전환한다.
    syncFile(input.directory);
    writeJson(path.join(input.directory, "latest.json"), manifest);
    syncFile(input.directory);
    return manifest;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
