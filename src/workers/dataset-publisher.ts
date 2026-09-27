import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { DATABASE_SCHEMA_VERSION, datasetIdentity } from "../runtime/shared/db/database-layout.js";
import { DATA_TABLE_NAMES } from "../server/shared/db/database-tables.js";
import type { DatasetManifest } from "../shared/agent-protocol.js";
import type { DatasetPublishActivity, DatasetPublishDiagnostic, DatasetPublishInput } from "../shared/dataset-publish-protocol.js";

export interface DatasetPublisherObserver {
  readonly onProgress?: (activity: DatasetPublishActivity) => void;
  readonly onDiagnostic?: (diagnostic: DatasetPublishDiagnostic) => void;
}

// 검증 연결만 최대 2GiB를 매핑한다. 초과 구간도 SQLite의 일반 읽기로 전체 검사한다.
const DEFAULT_MMAP_BYTES = 2 * 1024 * 1024 * 1024;

function syncFile(file: string): void {
  const fd = fs.openSync(file, "r");
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    syncFile(temporary);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function assertAllowedTables(database: Database.Database): void {
  const allowed = new Set<string>([...DATA_TABLE_NAMES, "dataset_state", "__drizzle_migrations", "sqlite_sequence"]);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  if (tables.some(({ name }) => !allowed.has(name)))
    throw new Error("배포할 수 없는 운영 테이블이 계산 DB에 있습니다");
}

/** Linux의 실제 디스크 읽기와 캐시를 포함한 읽기 호출 수를 구분한다. */
function ioCounters(): { readBytes: number; writeBytes: number; readCalls: number } | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const counters = new Map(fs.readFileSync("/proc/self/io", "utf8").trim().split("\n").map((line) => {
      const [key, value] = line.split(":");
      return [key!, Number(value)] as const;
    }));
    const values = { readBytes: counters.get("read_bytes"), writeBytes: counters.get("write_bytes"), readCalls: counters.get("syscr") };
    if (Object.values(values).some((value) => value === undefined || !Number.isSafeInteger(value))) return undefined;
    return values as { readBytes: number; writeBytes: number; readCalls: number };
  } catch {
    // /proc를 읽을 수 없는 환경에서도 게시 검증은 그대로 수행한다.
    return undefined;
  }
}

/** 게시 전용 자식과 성능 비교 도구가 같은 검증·동기화 경로를 사용한다. */
export async function publishDataset(input: DatasetPublishInput, observer: DatasetPublisherObserver = {}): Promise<DatasetManifest> {
  const copyMethod = input.copyMethod ?? "backup";
  const cacheKiB = input.cacheKiB ?? 16000;
  const mmapBytes = input.mmapBytes ?? DEFAULT_MMAP_BYTES;
  let effectiveMmapBytes: number | undefined;
  const measure = async <T>(stage: DatasetPublishDiagnostic["stage"], work: () => T | Promise<T>): Promise<T> => {
    const start = performance.now();
    const cpu = process.cpuUsage();
    const before = ioCounters();
    let outcome: DatasetPublishDiagnostic["outcome"] = "FAILED";
    try {
      const result = await work();
      outcome = "COMPLETED";
      return result;
    } finally {
      const elapsedMs = performance.now() - start;
      const usage = process.cpuUsage(cpu);
      const after = ioCounters();
      try {
        observer.onDiagnostic?.({
          event: "diagnostic.stage.finished", stage, outcome, elapsedMs,
          cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000,
          rssBytes: process.memoryUsage().rss, maxRssBytes: process.resourceUsage().maxRSS * 1024,
          ...(before && after ? {
            readBytes: Math.max(0, after.readBytes - before.readBytes),
            writeBytes: Math.max(0, after.writeBytes - before.writeBytes),
            readCalls: Math.max(0, after.readCalls - before.readCalls),
          } : {}),
          copyMethod, cacheKiB, mmapBytes,
          ...(effectiveMmapBytes === undefined ? {} : { effectiveMmapBytes }),
        });
      } catch {
        // 진단 전달 실패가 무결성 검사나 게시의 성공 여부를 바꾸지 않는다.
      }
    }
  };

  return measure("dataset_publish.total", async () => {
    const temporary = path.join(input.directory, `.${input.version}-${randomUUID()}.sqlite`);
    try {
      const source = new Database(input.sourcePath, { readonly: true, fileMustExist: true });
      try {
        // 대용량 파일 생성 전에 운영 테이블이 섞이지 않았는지 막는다.
        await measure("dataset_publish.source_tables", () => assertAllowedTables(source));
        source.pragma(`cache_size = -${cacheKiB}`);
        observer.onProgress?.("PUBLISHING_COPY");
        await measure("dataset_publish.copy", async () => {
          if (copyMethod === "vacuum") {
            source.pragma("synchronous = FULL");
            source.prepare("VACUUM INTO ?").run(temporary);
          } else {
            await source.backup(temporary);
          }
        });
      } finally { source.close(); }

      observer.onProgress?.("PUBLISHING_VERIFY");
      const snapshot = new Database(temporary, { fileMustExist: true });
      let identity: ReturnType<typeof datasetIdentity>;
      try {
        snapshot.pragma(`cache_size = -${cacheKiB}`);
        await measure("dataset_publish.journal_mode", () => snapshot.pragma("journal_mode = DELETE"));
        // 빌드·플랫폼 상한으로 요청한 매핑 크기가 줄어든 경우도 진단에 남긴다.
        const effective = snapshot.pragma(`mmap_size = ${mmapBytes}`, { simple: true });
        if (typeof effective === "number" && Number.isSafeInteger(effective) && effective >= 0)
          effectiveMmapBytes = effective;
        // 복사 중 원본이 바뀔 수 있으므로 생성된 파일도 다시 검사한다.
        await measure("dataset_publish.snapshot_tables", () => assertAllowedTables(snapshot));
        await measure("dataset_publish.quick_check", () => {
          if (snapshot.pragma("quick_check", { simple: true }) !== "ok") throw new Error("계산 DB 무결성 검사 실패");
        });
        identity = await measure("dataset_publish.identity", () => datasetIdentity(snapshot, "main"));
      } finally { snapshot.close(); }

      observer.onProgress?.("PUBLISHING_HASH");
      const sha256 = await measure("dataset_publish.hash", async () => {
        const hash = createHash("sha256");
        for await (const chunk of fs.createReadStream(temporary)) hash.update(chunk);
        return hash.digest("hex");
      });
      const manifest: DatasetManifest = {
        version: input.version, datasetId: identity.datasetId, sourceRevision: identity.revision,
        collectionVersion: input.collectionVersion, schemaVersion: DATABASE_SCHEMA_VERSION,
        sha256, bytes: fs.statSync(temporary).size,
      };
      observer.onProgress?.("PUBLISHING_COMMIT");
      fs.chmodSync(temporary, 0o444);
      await measure("dataset_publish.sync_snapshot", () => syncFile(temporary));
      await measure("dataset_publish.commit", () => {
        fs.renameSync(temporary, path.join(input.directory, `${manifest.version}-${manifest.sha256}.sqlite`));
        writeJson(path.join(input.directory, `${manifest.version}.json`), manifest);
        // 파일과 버전 명세를 동기화한 후 마지막에 최신 포인터를 교체한다.
        syncFile(input.directory);
        writeJson(path.join(input.directory, "latest.json"), manifest);
        syncFile(input.directory);
      });
      return manifest;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  });
}
