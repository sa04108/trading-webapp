import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { DATABASE_SCHEMA_VERSION } from '../../src/server/shared/db/database-layout.js';
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
