import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createDartCorpCodeCache } from "../../src/server/modules/facts/infrastructure/dart/dart-corp-code-cache.js";
import { DartRawSnapshotError } from "../../src/server/modules/facts/infrastructure/dart/dart-raw-snapshot-store.js";
import { SqliteDartCorpCodeSnapshotStore } from "../../src/server/modules/facts/infrastructure/dart/sqlite-dart-corp-code-snapshot-store.js";
import { openDatabase } from "../../src/runtime/shared/db/database.js";

const XML_A = `<result><list><corp_code>00126380</corp_code><stock_code>005930</stock_code></list></result>`;
const XML_B = `<result><list><corp_code>00999999</corp_code><stock_code>005930</stock_code></list></result>`;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function zip(xml: string): Buffer {
  const name = Buffer.from("CORPCODE.xml");
  const raw = Buffer.from(xml);
  const compressed = deflateRawSync(raw);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, compressed]);
}

describe("corpCode.xml 손상 복구", () => {
  it("현재 원문의 해시가 손상되면 복구 다운로드를 요청하고 손상 원문을 별도 이력으로 보존한다", async () => {
    const database = openDatabase(":memory:");
    try {
      const store = new SqliteDartCorpCodeSnapshotStore(database.sqlite, "dart");
      store.put(XML_A, 1);
      database.sqlite.prepare("UPDATE dart_corp_code_snapshot SET xml = ? WHERE namespace = ?").run("<tampered/>", "dart");
      const beforeDownload = vi.fn();
      const fetchZip = vi.fn(async () => zip(XML_B));
      const cache = createDartCorpCodeCache(fetchZip, store, () => 2, { allowRecovery: true, beforeDownload });

      await expect(cache.resolve("005930")).resolves.toBe("00999999");
      expect(fetchZip).toHaveBeenCalledTimes(1);
      expect(beforeDownload).toHaveBeenCalledWith(undefined, expect.objectContaining({ reason: "HASH_MISMATCH" }));
      expect(store.get()?.xml).toBe(XML_B);
      const history = database.sqlite.prepare("SELECT snapshot_json FROM dart_raw_api_snapshot_history").all() as {snapshot_json:string}[];
      expect(history.map(({snapshot_json}) => JSON.parse(snapshot_json))).toContainEqual(expect.objectContaining({
        kind: "CORP_CODE_CORRUPT", contentHash: hash(XML_A), actualContentHash: hash("<tampered/>"),
      }));
    } finally { database.close(); }
  });

  it("같은 해시의 정상 과거 사본이 있으면 HTTP 없이 로컬 원문을 사용한다", async () => {
    const database = openDatabase(":memory:");
    try {
      const store = new SqliteDartCorpCodeSnapshotStore(database.sqlite, "dart");
      store.put(XML_A, 1);
      database.sqlite.prepare("UPDATE dart_corp_code_snapshot SET xml = ? WHERE namespace = ?").run("<tampered/>", "dart");
      database.sqlite.prepare("INSERT INTO dart_raw_api_snapshot_history (snapshot_json, archived_at_ms) VALUES (?, ?)")
        .run(JSON.stringify({kind:"CORP_CODE", namespace:"dart", xml:XML_A, contentHash:hash(XML_A), fetchedAtMs:1}), 2);
      const fetchZip = vi.fn(async () => zip(XML_B));
      const cache = createDartCorpCodeCache(fetchZip, store, () => 3, { allowRecovery: true });

      await expect(cache.resolve("005930")).resolves.toBe("00126380");
      expect(fetchZip).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it("정상 이력과 다른 회사 고유번호는 계속 정체성 불일치로 차단한다", () => {
    const database = openDatabase(":memory:");
    try {
      const changed = vi.fn();
      const store = new SqliteDartCorpCodeSnapshotStore(database.sqlite, "dart", changed);
      store.put(XML_A, 1);
      store.put(XML_B, 2);
      expect(changed).toHaveBeenCalledWith("005930", "00126380", "00999999");
      const cache = createDartCorpCodeCache(async () => zip(XML_B), store);
      expect(() => cache.lookup?.("005930")).toThrow(/IDENTITY_MISMATCH/);
    } finally { database.close(); }
  });

  it("같은 해시 사본으로 복구해도 기존 회사 변경 이력을 숨기지 않는다", async () => {
    const database = openDatabase(":memory:");
    try {
      const store = new SqliteDartCorpCodeSnapshotStore(database.sqlite, "dart");
      store.put(XML_A, 1);
      store.put(XML_B, 2);
      store.put(XML_B, 3);
      database.sqlite.prepare("UPDATE dart_corp_code_snapshot SET xml = '<tampered/>'").run();
      const fetchZip = vi.fn(async () => zip(XML_B));
      const cache = createDartCorpCodeCache(fetchZip, store, () => 4, { allowRecovery: true });
      await expect(cache.resolve("005930")).rejects.toThrow("IDENTITY_MISMATCH");
      expect(fetchZip).not.toHaveBeenCalled();
      expect(store.get()?.changedSymbols).toEqual(["005930"]);
    } finally { database.close(); }
  });

  it("정체성 비교 이력의 손상은 새 원문 다운로드로 우회하지 않는다", async () => {
    const database = openDatabase(":memory:");
    try {
      const store = new SqliteDartCorpCodeSnapshotStore(database.sqlite, "dart");
      store.put(XML_A, 1); store.put(XML_A, 2);
      database.sqlite.prepare("UPDATE dart_raw_api_snapshot_history SET snapshot_json = ?").run(JSON.stringify({
        kind: "CORP_CODE", namespace: "dart", xml: XML_B, contentHash: hash(XML_A), fetchedAtMs: 1,
      }));
      const fetchZip = vi.fn(async () => zip(XML_B));
      const cache = createDartCorpCodeCache(fetchZip, store, () => 3, { allowRecovery: true });
      await expect(cache.resolve("005930")).rejects.toThrow("HASH_MISMATCH");
      expect(fetchZip).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it("복구 허용이 없으면 해시 손상은 기존처럼 다운로드 전에 차단한다", async () => {
    const corrupted = new DartRawSnapshotError("HASH_MISMATCH", "corpCode.xml");
    const store = { get: () => { throw corrupted; }, put() {} };
    const fetchZip = vi.fn(async () => zip(XML_A));
    const cache = createDartCorpCodeCache(fetchZip, store);

    await expect(cache.resolve("005930")).rejects.toBe(corrupted);
    expect(fetchZip).not.toHaveBeenCalled();
  });
});
