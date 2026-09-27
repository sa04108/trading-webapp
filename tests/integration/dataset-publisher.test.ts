import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle } from "../../src/runtime/shared/db/database.js";
import { datasetIdentity } from "../../src/runtime/shared/db/database-layout.js";
import { datasetPublishDiagnosticSchema, type DatasetPublishDiagnostic } from "../../src/shared/dataset-publish-protocol.js";
import { publishDataset } from "../../src/workers/dataset-publisher.js";
import { DatasetSnapshots } from "../../src/server/modules/agents/application/dataset-snapshots.js";

let directory: string;
let database: DatabaseHandle;
const collectionVersion = "a".repeat(64);

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "qp-publisher-"));
  database = openDatabase(path.join(directory, "app.sqlite"));
  database.sqlite.exec(`INSERT INTO data.facts
    (scope, key, field, period_key, as_of_ts_ms, value, unit)
    VALUES ('SYMBOL', '005930', 'NET_INCOME', '2025Q1', 100, 123, 'KRW')`);
});

afterEach(() => {
  vi.restoreAllMocks();
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function input(version = 1, copyMethod: "backup" | "vacuum" = "backup") {
  return { sourcePath: database.dataPath, directory, version, collectionVersion, copyMethod };
}

function logicalRows(sqlite: Database.Database, table: string, namespace: "main" | "data"): string[] {
  const identifier = `"${table.replaceAll('"', '""')}"`;
  return sqlite.prepare(`SELECT * FROM ${namespace}.${identifier}`).all().map((row) => JSON.stringify(row)).sort();
}

it.each(["backup", "vacuum"] as const)("%s 게시는 논리 데이터·스키마·정체성과 파일 해시를 보존한다", async (copyMethod) => {
  const diagnostics: DatasetPublishDiagnostic[] = [];
  const original = datasetIdentity(database.sqlite);
  const manifest = await publishDataset(input(1, copyMethod), { onDiagnostic: (value) => diagnostics.push(value) });
  const filename = path.join(directory, `${manifest.version}-${manifest.sha256}.sqlite`);
  const snapshot = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    expect(datasetIdentity(snapshot, "main")).toEqual(original);
    const tables = snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const { name } of tables) expect(logicalRows(snapshot, name, "main")).toEqual(logicalRows(database.sqlite, name, "data"));
    const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name";
    expect(snapshot.prepare(schema).all()).toEqual(database.sqlite.prepare(schema.replace("sqlite_master", "data.sqlite_master")).all());
    expect(snapshot.pragma("quick_check", { simple: true })).toBe("ok");
  } finally { snapshot.close(); }
  expect(manifest).toMatchObject({ datasetId: original.datasetId, sourceRevision: original.revision, collectionVersion });
  expect(fs.statSync(filename).mode & 0o222).toBe(0);
  expect(fs.statSync(filename).size).toBe(manifest.bytes);
  expect(createHash("sha256").update(fs.readFileSync(filename)).digest("hex")).toBe(manifest.sha256);
  expect(JSON.parse(fs.readFileSync(path.join(directory, "latest.json"), "utf8"))).toEqual(manifest);
  expect(diagnostics.map((value) => value.stage)).toEqual([
    "dataset_publish.source_tables", "dataset_publish.copy", "dataset_publish.journal_mode",
    "dataset_publish.snapshot_tables", "dataset_publish.quick_check", "dataset_publish.identity",
    "dataset_publish.hash", "dataset_publish.sync_snapshot", "dataset_publish.commit", "dataset_publish.total",
  ]);
  for (const value of diagnostics) {
    expect(datasetPublishDiagnosticSchema.safeParse(value).success).toBe(true);
    expect(value.outcome).toBe("COMPLETED");
    expect(value.copyMethod).toBe(copyMethod);
  }
});

it.each(["backup", "vacuum"] as const)("%s 게시 검증 실패는 기존 latest와 파일을 보존한다", async (copyMethod) => {
  const first = await publishDataset(input(1, copyMethod));
  const original = fs.readFileSync(path.join(directory, `${first.version}-${first.sha256}.sqlite`));
  const diagnostics: DatasetPublishDiagnostic[] = [];
  database.sqlite.pragma("ignore_check_constraints = ON");
  database.sqlite.exec(`INSERT INTO data.facts
    (scope, key, field, period_key, as_of_ts_ms, value, unit)
    VALUES ('INVALID', '005930', 'NET_INCOME', '2025Q1', 101, 123, 'KRW')`);
  await expect(publishDataset(input(2, copyMethod), { onDiagnostic: (value) => diagnostics.push(value) })).rejects.toThrow();
  expect(diagnostics.at(-1)).toMatchObject({ stage: "dataset_publish.total", outcome: "FAILED" });
  expect(JSON.parse(fs.readFileSync(path.join(directory, "latest.json"), "utf8"))).toEqual(first);
  expect(fs.readFileSync(path.join(directory, `${first.version}-${first.sha256}.sqlite`))).toEqual(original);
  expect(fs.readdirSync(directory).filter((name) => /^\.2-.*\.sqlite$/.test(name))).toEqual([]);
  expect(fs.existsSync(path.join(directory, "2.json"))).toBe(false);
});

it("생성본에 운영 테이블이 섞이면 해시·최신 포인터 게시 전에 거부한다", async () => {
  await expect(publishDataset(input(), {
    onProgress: (activity) => {
      if (activity !== "PUBLISHING_VERIFY") return;
      const name = fs.readdirSync(directory).find((value) => /^\.1-.*\.sqlite$/.test(value))!;
      const snapshot = new Database(path.join(directory, name));
      try { snapshot.exec("CREATE TABLE forbidden_operation_state (id INTEGER)"); }
      finally { snapshot.close(); }
    },
  })).rejects.toThrow("운영 테이블");
  expect(fs.existsSync(path.join(directory, "latest.json"))).toBe(false);
});

it("진단 수신자 오류는 게시를 막지 않는다", async () => {
  await expect(publishDataset(input(), { onDiagnostic: () => { throw new Error("진단 수신 실패"); } })).resolves.toMatchObject({ version: 1 });
});

it.each([0, Number.MAX_SAFE_INTEGER])("매핑 요청 %s에서도 전체 검사·게시를 유지하고 적용 상한을 기록한다", async (mmapBytes) => {
  const diagnostics: DatasetPublishDiagnostic[] = [];
  const manifest = await publishDataset({ ...input(), mmapBytes }, { onDiagnostic: (value) => diagnostics.push(value) });
  const verification = diagnostics.find((value) => value.stage === "dataset_publish.quick_check")!;
  expect(verification).toMatchObject({ outcome: "COMPLETED", mmapBytes });
  // 매핑을 지원하지 않는 빌드는 일반 읽기로 검증을 완료한다.
  if (verification.effectiveMmapBytes !== undefined) {
    expect(verification.effectiveMmapBytes).toBeGreaterThanOrEqual(0);
    expect(verification.effectiveMmapBytes).toBeLessThanOrEqual(mmapBytes);
    if (mmapBytes === 0) expect(verification.effectiveMmapBytes).toBe(0);
  }
  expect(JSON.parse(fs.readFileSync(path.join(directory, "latest.json"), "utf8"))).toEqual(manifest);
});

it("latest 교체 전 commit 실패는 기존 명세와 실행 파일을 보존한다", async () => {
  const first = await publishDataset(input());
  const original = fs.readFileSync(path.join(directory, `${first.version}-${first.sha256}.sqlite`));
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === path.join(directory, "latest.json")) throw new Error("최신 포인터 교체 실패");
    rename(from, to);
  });
  const diagnostics: DatasetPublishDiagnostic[] = [];
  await expect(publishDataset(input(2), { onDiagnostic: (value) => diagnostics.push(value) })).rejects.toThrow("최신 포인터 교체 실패");
  expect(diagnostics.filter((value) => value.outcome === "FAILED").map((value) => value.stage)).toEqual([
    "dataset_publish.commit", "dataset_publish.total",
  ]);
  expect(JSON.parse(fs.readFileSync(path.join(directory, "latest.json"), "utf8"))).toEqual(first);
  expect(fs.readFileSync(path.join(directory, `${first.version}-${first.sha256}.sqlite`))).toEqual(original);
  expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("자식 계측 IPC는 게시 결과와 구분되고 동시 게시 요청은 합쳐진다", async () => {
  const diagnostics: (DatasetPublishDiagnostic & { childPid?: number; datasetVersion: number })[] = [];
  const snapshots = new DatasetSnapshots(database, directory, { collectionVersion, onDiagnostic: (value) => diagnostics.push(value) });
  try {
    const first = snapshots.ensureLatest();
    expect(snapshots.ensureLatest()).toBe(first);
    const manifest = await first;
    expect(diagnostics.at(-1)).toMatchObject({ stage: "dataset_publish.total", outcome: "COMPLETED", datasetVersion: manifest.version });
    expect(diagnostics.at(-1)?.childPid).not.toBe(process.pid);
    expect(diagnostics.at(-1)?.childPid).toBeGreaterThan(0);
    const count = diagnostics.length;
    expect(await snapshots.ensureLatest()).toEqual(manifest);
    expect(diagnostics).toHaveLength(count);
  } finally { await snapshots.stop(); }
});

it("복사 후 원본 갱신은 후속 게시에 반영하고 이미 게시된 파일은 고정한다", async () => {
  const before = datasetIdentity(database.sqlite);
  const snapshots = new DatasetSnapshots(database, directory, { collectionVersion });
  let changed = false;
  const unsubscribe = snapshots.subscribe((progress) => {
    if (changed || progress?.activity !== "PUBLISHING_VERIFY") return;
    changed = true;
    database.sqlite.exec("UPDATE data.facts SET value = 124 WHERE key = '005930'");
  });
  try {
    const first = await snapshots.ensureLatest();
    expect(changed).toBe(true);
    expect(first.sourceRevision).toBe(before.revision);
    const original = fs.readFileSync(snapshots.file(first));
    const second = await snapshots.ensureLatest();
    expect(second.sourceRevision).toBe(before.revision + 1);
    expect(second.version).toBe(first.version + 1);
    expect(fs.readFileSync(snapshots.file(first))).toEqual(original);
  } finally { unsubscribe(); await snapshots.stop(); }
});
