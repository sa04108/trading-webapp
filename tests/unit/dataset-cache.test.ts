import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDatasetCache } from "../../src/agent/dataset-cache.js";
import { DATABASE_SCHEMA_VERSION } from "../../src/runtime/shared/db/database-layout.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dataset-cache-"));
  dirs.push(dir);
  const file = path.join(dir, "source.sqlite");
  const db = new Database(file);
  const datasetId = "e70c03d5-39cf-4fb9-953c-61b57726f062";
  db.exec(`CREATE TABLE dataset_state (singleton INTEGER, dataset_id TEXT, revision INTEGER);
    INSERT INTO dataset_state VALUES (1, '${datasetId}', 1)`);
  db.close();
  const data = fs.readFileSync(file);
  const manifest = { version: 1, datasetId, sourceRevision: 1, collectionVersion: "a".repeat(64),
    schemaVersion: DATABASE_SCHEMA_VERSION, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
  let notify: (() => void) | undefined;
  const cache = new AgentDatasetCache(path.join(dir, "cache"), { serverUrl: "http://localhost", token: "x".repeat(32) },
    (progress) => { if (progress.activity === "DOWNLOADING_DATASET") { const callback = notify; notify = undefined; callback?.(); } });
  return { cache, controller, data, manifest, nextProgress: () => new Promise<void>((resolve) => { notify = resolve; }) };
}

it("바이트가 계속 도착하면 30분이 지나도 다운로드를 검증하고 게시한다", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { cache, controller, data, manifest, nextProgress } = fixture();
  const download = cache.synchronize(manifest);
  for (let i = 0; i < 20; i++) {
    const progress = nextProgress();
    const start = Math.floor(i * data.length / 20);
    const end = Math.floor((i + 1) * data.length / 20);
    controller.enqueue(data.subarray(start, end));
    await progress;
    if (i < 19) await vi.advanceTimersByTimeAsync(100_000);
  }
  controller.close();
  await download;
  expect(cache.current).toEqual(manifest);
  expect(fs.readFileSync(cache.file(manifest))).toEqual(data);
});

it.each(["idle", "stop"])("%s 시 미완성 파일을 삭제하고 게시하지 않는다", async (reason) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { cache, controller, data, manifest, nextProgress } = fixture();
  const download = cache.synchronize(manifest);
  const rejected = expect(download).rejects.toThrow();
  const progress = nextProgress();
  controller.enqueue(data.subarray(0, 128));
  await progress;
  if (reason === "idle") await vi.advanceTimersByTimeAsync(120_000);
  else await cache.stop();
  await rejected;
  expect(cache.current).toBeNull();
  expect(fs.existsSync(`${cache.file(manifest)}.part`)).toBe(false);
  expect(fs.existsSync(cache.file(manifest))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
