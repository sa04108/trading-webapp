import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { DatasetSnapshots } from '../../src/server/modules/agents/application/dataset-snapshots.js';
import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import { DATABASE_SCHEMA_VERSION } from '../../src/runtime/shared/db/database-layout.js';

it('수집 버전 없는 구형 스냅샷도 임대 보존이 끝나면 파일과 명세를 함께 정리한다', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-snapshot-prune-'));
  const database = openDatabase(':memory:');
  const shared = { datasetId: randomUUID(), sourceRevision: 0, schemaVersion: DATABASE_SCHEMA_VERSION, sha256: 'a'.repeat(64), bytes: 1 };
  const filename = (version: number) => path.join(directory, `${version}-${shared.sha256}.sqlite`);
  for (const version of [1, 2, 3, 4]) {
    const manifest = { ...shared, version, ...(version >= 3 ? { collectionVersion: readRuntimeVersions().collectionVersion } : {}) };
    fs.writeFileSync(filename(version), 'x');
    fs.writeFileSync(path.join(directory, `${version}.json`), JSON.stringify(manifest));
    if (version === 4) fs.writeFileSync(path.join(directory, 'latest.json'), JSON.stringify(manifest));
  }
  const snapshots = new DatasetSnapshots(database, directory);
  try {
    snapshots.prune(new Set([2]));
    expect(fs.existsSync(filename(1))).toBe(false);
    expect(fs.existsSync(path.join(directory, '1.json'))).toBe(false);
    for (const version of [2, 3, 4]) expect(fs.existsSync(filename(version))).toBe(true);
    snapshots.prune(new Set());
    expect(fs.existsSync(filename(2))).toBe(false);
    expect(fs.existsSync(path.join(directory, '2.json'))).toBe(false);
  } finally {
    await snapshots.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
