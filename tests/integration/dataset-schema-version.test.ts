import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { DATABASE_SCHEMA_VERSION } from '../../src/runtime/shared/db/database-layout.js';
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
    await cache.synchronize(current);
    expect(cache.current).toEqual(current);
    await expect(snapshots.ensureLatest()).resolves.toEqual(current);
  } finally {
    await cache.stop();
    await snapshots.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

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
    database.sqlite
      .prepare("UPDATE data.dataset_state SET revision = revision + 1 WHERE singleton = 1")
      .run();
    await expect(snapshots.ensureLatest()).resolves.toMatchObject({ sourceRevision: 1 });
  } finally {
    await snapshots.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
