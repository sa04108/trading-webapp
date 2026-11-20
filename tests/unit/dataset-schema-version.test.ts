import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { DATABASE_SCHEMA_VERSION, datasetIdentity } from '../../src/runtime/shared/db/database-layout.js';
import { DatasetSnapshots } from '../../src/server/modules/agents/application/dataset-snapshots.js';
import { AgentDatasetCache } from '../../src/agent/dataset-cache.js';

it('데이터 revision이 같아도 이전 스키마 스냅샷은 재게시하고 클라이언트는 구버전을 거부한다', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-schema-version-'));
  const database = openDatabase(path.join(directory, 'app.sqlite'));
  let snapshots = new DatasetSnapshots(database, path.join(directory, 'published'));
  const cache = new AgentDatasetCache(path.join(directory, 'cache'), { serverUrl: 'http://127.0.0.1', token: 'x'.repeat(32) });
  try {
    const first = await snapshots.ensureLatest();
    expect(first.schemaVersion).toBe(DATABASE_SCHEMA_VERSION);
    await snapshots.stop();
    const oldSchema = { ...first, schemaVersion: DATABASE_SCHEMA_VERSION - 1 };
    fs.writeFileSync(path.join(directory, 'published/latest.json'), JSON.stringify(oldSchema));
    snapshots = new DatasetSnapshots(database, path.join(directory, 'published'));
    const current = await snapshots.ensureLatest();
    expect(current.version).toBe(first.version + 1);
    expect(current.sourceRevision).toBe(first.sourceRevision);
    expect(current.schemaVersion).toBe(DATABASE_SCHEMA_VERSION);
    await expect(cache.synchronize(oldSchema)).rejects.toThrow('클라이언트를 업데이트');
    fs.copyFileSync(snapshots.file(current), cache.file(current));
    const verifying = cache.synchronize(current);
    cache.prune(new Set());
    await verifying;
    expect(cache.current).toEqual(current);
    await expect(snapshots.ensureLatest()).resolves.toEqual(current);
  } finally {
    await cache.stop();
    await snapshots.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

it('에이전트 종료는 기존 캐시 검증과 대기 요청을 중단하고 다운로드를 시작하지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-cache-stop-'));
  const cache = new AgentDatasetCache(dir, { serverUrl: 'http://127.0.0.1', token: 'x'.repeat(32) });
  const manifest = { version: 1, datasetId: 'a87b7ae5-806e-4c7d-8c7b-4a2995ddeeec', sourceRevision: 1,
    collectionVersion: 'b'.repeat(64), schemaVersion: DATABASE_SCHEMA_VERSION, sha256: 'a'.repeat(64), bytes: 1 };
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('예상하지 않은 다운로드'));
  try {
    fs.writeFileSync(cache.file(manifest), 'x');
    const attempts = Promise.allSettled([cache.synchronize(manifest), cache.synchronize({ ...manifest, version: 2 })]);
    await cache.stop();
    for (const result of await attempts) expect(result).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    await expect(cache.synchronize(manifest)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.current).toBeNull();
  } finally {
    fetch.mockRestore();
    await cache.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('수집 버전만 바뀌어도 새 데이터셋을 게시하고 이전 스냅샷과 revision을 보존한다', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-collection-version-'));
  const database = openDatabase(path.join(directory, 'app.sqlite'));
  let snapshots = new DatasetSnapshots(database, path.join(directory, 'published'), { collectionVersion: 'a'.repeat(64) });
  try {
    const first = await snapshots.ensureLatest();
    const original = fs.readFileSync(snapshots.file(first));
    await snapshots.stop();
    snapshots = new DatasetSnapshots(database, path.join(directory, 'published'), { collectionVersion: 'b'.repeat(64) });
    const current = await snapshots.ensureLatest();
    expect(current.version).toBe(first.version + 1);
    expect(current.sourceRevision).toBe(first.sourceRevision);
    expect(current.collectionVersion).toBe('b'.repeat(64));
    expect(snapshots.get(first.version)).toEqual(first);
    expect(fs.readFileSync(snapshots.file(first))).toEqual(original);
    await expect(snapshots.ensureLatest()).resolves.toEqual(current);
  } finally {
    await snapshots.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);


it("금지 테이블은 복사 전에 거부하고 같은 실패는 잠시 재시도하지 않는다", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qp-publish-backoff-"));
  const database = openDatabase(path.join(directory, "app.sqlite"));
  let now = 1_000;
  const snapshots = new DatasetSnapshots(database, path.join(directory, "published"), {
    now: () => now,
  });
  const activities: string[] = [];
  const unsubscribe = snapshots.subscribe((progress) => {
    if (progress) activities.push(progress.activity);
  });
  try {
    database.sqlite.exec("CREATE TABLE data.forbidden_operation_state (id INTEGER)");
    await expect(snapshots.ensureLatest()).rejects.toThrow("운영 테이블");
    expect(activities).not.toContain("PUBLISHING_COPY");
    expect(fs.readdirSync(path.join(directory, "published"))).not.toContainEqual(
      expect.stringMatching(/^\.\d+-.*\.sqlite$/),
    );

    await expect(snapshots.ensureLatest()).rejects.toThrow("재시도 대기");
    expect(activities).not.toContain("PUBLISHING_COPY");

    now += 30_000;
    await expect(snapshots.ensureLatest()).rejects.toThrow("운영 테이블");

    database.sqlite.exec("DROP TABLE data.forbidden_operation_state");
    now += 30_000;
    const recovered = await snapshots.ensureLatest();
    await expect(snapshots.ensureLatest()).resolves.toEqual(recovered);
  } finally {
    unsubscribe();
    await snapshots.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

it("게시 실패 후 source revision이 바뀌면 대기 시간 없이 다시 시도한다", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qp-publish-revision-"));
  const database = openDatabase(path.join(directory, "app.sqlite"));
  const snapshots = new DatasetSnapshots(database, path.join(directory, "published"));
  try {
    database.sqlite.exec("CREATE TABLE data.forbidden_operation_state (id INTEGER)");
    await expect(snapshots.ensureLatest()).rejects.toThrow("운영 테이블");
    database.sqlite.exec("DROP TABLE data.forbidden_operation_state");
    const revision = datasetIdentity(database.sqlite).revision;
    database.sqlite
      .prepare("UPDATE data.dataset_state SET revision = revision + 1 WHERE singleton = 1")
      .run();
    await expect(snapshots.ensureLatest()).resolves.toMatchObject({ sourceRevision: revision + 1 });
  } finally {
    await snapshots.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
