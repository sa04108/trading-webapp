import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  createDisposableDatabase,
  parseBenchmarkOptions,
} from './universe-benchmark-common.js';

const sourceTemplate = process.argv[2];
if (sourceTemplate === undefined) {
  throw new Error('usage: tsx scripts/manual/universe-benchmark-safety-smoke.ts <empty-migrated.sqlite>');
}

// 첫 복제부터 제품 helper를 사용해야 운영 realpath/sanitized guard를 우회하지 않는다.
const initial = await createDisposableDatabase(sourceTemplate);
const root = initial.dir;
const source = initial.databasePath;
const db = new Database(source);
const disposableDirs: string[] = [];
try {
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.prepare(
    'INSERT INTO symbols (code, market, name, standard_code, created_at_ms) VALUES (?, ?, ?, ?, ?)',
  ).run('900001', 'KR', 'WAL-A', 'KR7900000001', 1);
  const first = await createDisposableDatabase(source);
  disposableDirs.push(first.dir);

  // 행 수는 그대로 두고 main DB를 checkpoint하지 않은 WAL 값만 변경한다.
  db.prepare('UPDATE symbols SET name = ? WHERE code = ?').run('WAL-B', '900001');
  const second = await createDisposableDatabase(source);
  disposableDirs.push(second.dir);
  assert.notEqual(first.sourceSha256, second.sourceSha256);
  const copied = new Database(second.databasePath, { readonly: true });
  assert.equal(
    (copied.prepare('SELECT name FROM symbols WHERE code = ?').get('900001') as { name: string }).name,
    'WAL-B',
  );
  copied.close();

  const hardlink = path.join(root, 'output-hardlink.sqlite');
  fs.linkSync(source, hardlink);
  assert.throws(
    () => parseBenchmarkOptions(['--database', source, '--output', hardlink]),
    /symlink\/hardlink/,
  );
  const symlink = path.join(root, 'output-symlink.sqlite');
  fs.symlinkSync(source, symlink);
  assert.throws(
    () => parseBenchmarkOptions(['--database', source, '--output', symlink]),
    /symlink\/hardlink/,
  );
  assert.throws(
    () => parseBenchmarkOptions(['--database', source, '--output', source]),
    /같은 경로/,
  );
  await assert.rejects(
    createDisposableDatabase('/var/lib/quant-platform/app.sqlite'),
    /운영 DB 경로/,
  );

  db.prepare(
    'INSERT INTO users '
    + '(id, username, password_hash, totp_secret, totp_enabled, totp_last_used_step, '
    + 'recovery_code_hashes_json, created_at_ms, updated_at_ms) '
    + 'VALUES (?, ?, ?, NULL, 0, NULL, ?, ?, ?)',
  ).run('usr_safety', 'safety', 'not-a-real-hash', '[]', 1, 1);
  await assert.rejects(createDisposableDatabase(source), /users 테이블/);
  console.log(JSON.stringify({
    walSnapshotHashesDiffer: true,
    copiedWalValue: true,
    outputSameFileRejected: true,
    outputHardlinkRejected: true,
    outputSymlinkRejected: true,
    productionPathRejected: true,
    sensitiveRowsRejected: true,
  }));
} finally {
  db.close();
  for (const dir of disposableDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}
