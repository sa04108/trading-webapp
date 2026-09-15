import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { dataDatabasePath, tableExists } from '../../../runtime/shared/db/database-layout.js';

interface BackupManifest { version: 1; operationsSha256: string; dataSha256: string }
interface RestoreJournal { version: 1; databasePath: string; snapshotPath: string; staged: string; manifest: BackupManifest }

function sync(file: string): void { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
async function checksum(file: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); sync(temporary);
  fs.renameSync(temporary, file); sync(path.dirname(file));
}
async function copyConsistent(source: string, target: string): Promise<void> {
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try { await database.backup(target); } finally { database.close(); }
  fs.chmodSync(target, 0o600); sync(target);
}

/** 모든 쓰기를 중지한 배포 구간에서 운영·계산 파일을 함께 백업한다. */
export async function backupDatabase(databasePath: string, snapshotPath: string): Promise<void> {
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(source, 'operational_database_state')) throw new Error('분리된 운영·계산 DB만 백업할 수 있습니다');
  } finally { source.close(); }
  const files = [snapshotPath, `${snapshotPath}.data`, `${snapshotPath}.json`];
  if (files.some((file) => fs.existsSync(file))) throw new Error('백업 대상 파일이 이미 존재합니다');
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  try {
    await copyConsistent(databasePath, snapshotPath);
    await copyConsistent(dataDatabasePath(databasePath), `${snapshotPath}.data`);
    const manifest: BackupManifest = { version: 1, operationsSha256: await checksum(snapshotPath), dataSha256: await checksum(`${snapshotPath}.data`) };
    writeJson(`${snapshotPath}.json`, manifest);
  } catch (error) { for (const file of files) fs.rmSync(file, { force: true }); throw error; }
}

/** 복원 명세가 사라질 때까지 앱은 부팅하지 않는다. 중단 후 같은 명령으로 재개한다. */
export async function restoreDatabase(databasePath: string, snapshotPath: string): Promise<void> {
  databasePath = path.resolve(databasePath); snapshotPath = path.resolve(snapshotPath);
  const manifest = JSON.parse(fs.readFileSync(`${snapshotPath}.json`, 'utf8')) as BackupManifest;
  if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.operationsSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.dataSha256)) throw new Error('DB 백업 명세가 올바르지 않습니다');
  if (await checksum(snapshotPath) !== manifest.operationsSha256
    || await checksum(`${snapshotPath}.data`) !== manifest.dataSha256) throw new Error('DB 백업 파일 해시가 다릅니다');
  const journalPath = `${databasePath}.restore.json`;
  let journal: RestoreJournal;
  if (fs.existsSync(journalPath)) {
    journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as RestoreJournal;
    if (journal.version !== 1 || journal.databasePath !== databasePath || journal.snapshotPath !== snapshotPath
      || path.dirname(journal.staged) !== path.dirname(databasePath)
      || !path.basename(journal.staged).startsWith(`${path.basename(databasePath)}.restore-`)
      || JSON.stringify(journal.manifest) !== JSON.stringify(manifest)) throw new Error('진행 중인 DB 복원 기록이 다릅니다');
  } else {
    const staged = `${databasePath}.restore-${randomUUID()}.sqlite`;
    fs.copyFileSync(snapshotPath, staged); fs.chmodSync(staged, 0o600); sync(staged);
    fs.copyFileSync(`${snapshotPath}.data`, `${staged}.data`); fs.chmodSync(`${staged}.data`, 0o600); sync(`${staged}.data`);
    journal = { version: 1, databasePath, snapshotPath, staged, manifest };
    writeJson(journalPath, journal);
  }
  for (const file of [databasePath, dataDatabasePath(databasePath)]) {
    for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${file}${suffix}`, { force: true });
  }
  if (fs.existsSync(`${journal.staged}.data`)) fs.renameSync(`${journal.staged}.data`, dataDatabasePath(databasePath));
  if (fs.existsSync(journal.staged)) fs.renameSync(journal.staged, databasePath);
  sync(path.dirname(databasePath));
  if (await checksum(databasePath) !== manifest.operationsSha256
    || await checksum(dataDatabasePath(databasePath)) !== manifest.dataSha256) throw new Error('복원된 DB 파일이 백업과 다릅니다');
  fs.rmSync(journalPath); sync(path.dirname(databasePath));
}
