import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { dataDatabasePath, sqlIdentifier, tableExists } from './database-layout.js';
import { DATA_TABLE_NAMES, OPERATIONAL_TABLE_NAMES } from './database-tables.js';

interface SplitJournal {
  schemaVersion: 1;
  sourcePath: string;
  dataPath: string;
  stagedOperationsPath: string;
  stagedDataPath: string;
  backupPath: string;
  datasetId: string;
}

export interface SplitMigrationResult {
  readonly status: 'NEW' | 'ALREADY_SPLIT' | 'MIGRATED' | 'RECOVERED';
  readonly backupPath?: string;
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeJournal(file: string, journal: SplitJournal): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(journal)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}

function verifyIdentity(file: string, role: 'operations' | 'data', expected: string, verifyContent = true): void {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('DB 분리 대상은 심볼릭 링크일 수 없습니다');
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const table = role === 'data' ? 'dataset_state' : 'operational_database_state';
    const row = sqlite.prepare(`SELECT dataset_id AS id FROM ${table} WHERE singleton = 1`).get() as { id: string } | undefined;
    if (row?.id !== expected) throw new Error(`DB 분리 대상의 식별자가 다릅니다: ${file}`);
    if (verifyContent) {
      const integrity = sqlite.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error(`DB 무결성 검사 실패: ${file}`);
      if ((sqlite.pragma('foreign_key_check') as unknown[]).length > 0) throw new Error(`DB 참조 무결성 검사 실패: ${file}`);
    }
  } finally { sqlite.close(); }
}

function validateJournal(journal: SplitJournal, sourcePath: string): void {
  const directory = path.dirname(sourcePath);
  if (journal.schemaVersion !== 1 || journal.sourcePath !== sourcePath
    || journal.dataPath !== dataDatabasePath(sourcePath)
    || typeof journal.datasetId !== 'string'
    || !/^[a-f0-9-]{36}$/.test(journal.datasetId)) {
    throw new Error('DB 분리 기록 형식이 올바르지 않습니다');
  }
  for (const file of [journal.stagedOperationsPath, journal.stagedDataPath, journal.backupPath]) {
    if (typeof file !== 'string' || path.dirname(file) !== directory
      || !path.basename(file).startsWith(`${path.basename(sourcePath)}.split-`)) {
      throw new Error('DB 분리 기록의 파일 경로가 허용 범위를 벗어났습니다');
    }
  }
  if (new Set([sourcePath, journal.dataPath, journal.stagedOperationsPath, journal.stagedDataPath, journal.backupPath]).size !== 5) {
    throw new Error('DB 분리 기록의 파일 경로가 중복됩니다');
  }
}

/** 검증된 두 파일을 차례로 활성화한다. 중단된 구간은 기록과 파일 식별자로 복구한다. */
function publishSplit(journal: SplitJournal, alreadyVerified = false): void {
  const { sourcePath, dataPath, backupPath, stagedOperationsPath, stagedDataPath, datasetId } = journal;
  validateJournal(journal, sourcePath);
  const operationsCandidate = fs.existsSync(stagedOperationsPath) ? stagedOperationsPath : sourcePath;
  const dataCandidate = fs.existsSync(stagedDataPath) ? stagedDataPath : dataPath;
  verifyIdentity(operationsCandidate, 'operations', datasetId, !alreadyVerified);
  verifyIdentity(dataCandidate, 'data', datasetId, !alreadyVerified);
  if (!fs.existsSync(backupPath)) {
    if (!fs.existsSync(stagedOperationsPath)) throw new Error('DB 분리 원본 백업이 없습니다');
    fs.renameSync(sourcePath, backupPath);
    syncDirectory(path.dirname(sourcePath));
  }
  if (fs.existsSync(stagedDataPath)) {
    if (fs.existsSync(dataPath)) throw new Error('새 계산 DB 경로가 다른 파일에 의해 사용 중입니다');
    fs.renameSync(stagedDataPath, dataPath);
    syncDirectory(path.dirname(sourcePath));
  }
  if (fs.existsSync(stagedOperationsPath)) {
    if (fs.existsSync(sourcePath)) throw new Error('새 운영 DB 경로가 다른 파일에 의해 사용 중입니다');
    fs.renameSync(stagedOperationsPath, sourcePath);
    syncDirectory(path.dirname(sourcePath));
  }
  // 이름 교체는 검증된 파일 내용을 바꾸지 않는다. 최종 위치와 식별자만 다시 확인한다.
  verifyIdentity(sourcePath, 'operations', datasetId, false);
  verifyIdentity(dataPath, 'data', datasetId, false);
  fs.unlinkSync(`${sourcePath}.split-migration.json`);
  syncDirectory(path.dirname(sourcePath));
}

function copyTables(sqlite: Database.Database, tables: readonly string[], destination: string, report: (message: string) => void): void {
  for (const table of tables) {
    const name = sqlIdentifier(table);
    const sourceColumns = (sqlite.pragma(`main.table_info(${name})`) as Array<{ name: string }>);
    if (!sourceColumns.length) throw new Error(`기존 DB에 필수 테이블이 없습니다: ${table}`);
    // 단일 DB는 과거 컬럼을 유지한다. 최신 운영 스키마로 옮길 때만 소유자 명칭을 이행한다.
    const columns = sourceColumns.map(({ name: column }) =>
      sqlIdentifier(table === 'backtest_jobs' && column === 'worker_id' ? 'agent_id' : column)).join(', ');
    const sourceValues = sourceColumns.map(({ name: column }) => {
      const identifier = sqlIdentifier(column);
      return table === 'backtest_jobs' && column === 'worker_id'
        ? `CASE WHEN ${identifier} GLOB 'remote:*' THEN substr(${identifier}, 8) ELSE ${identifier} END`
        : identifier;
    }).join(', ');
    report(`DB 분리 복사: ${table}`);
    // 기존 스키마의 테이블은 모두 rowid를 가진다. 삽입 순서를 고정해 큰 정렬 없이
    // 두 테이블을 같은 순서로 읽고, 정수·문자열·BLOB을 손실 없이 한 행씩 대조한다.
    sqlite.exec(`DELETE FROM ${destination}.${name}; INSERT INTO ${destination}.${name} (${columns}) SELECT ${sourceValues} FROM main.${name} ORDER BY _rowid_;`);
    report(`DB 분리 대조: ${table}`);
    const original = sqlite.prepare(`SELECT ${sourceValues} FROM main.${name} ORDER BY _rowid_`).raw().safeIntegers().iterate();
    const copied = sqlite.prepare(`SELECT ${columns} FROM ${destination}.${name} ORDER BY _rowid_`).raw().safeIntegers().iterate();
    let count = 0;
    try {
      for (const row of original) {
        const next = copied.next();
        const values = row as unknown[];
        const actual = next.value as unknown[] | undefined;
        if (next.done || !actual || values.length !== actual.length || values.some((value, index) =>
          Buffer.isBuffer(value) ? !Buffer.isBuffer(actual[index]) || !value.equals(actual[index]) : value !== actual[index])) {
          throw new Error(`이전한 데이터가 원본과 다릅니다: ${table}`);
        }
        count++;
      }
      if (!copied.next().done) throw new Error(`이전한 데이터가 원본과 다릅니다: ${table}`);
    } finally {
      original.return?.();
      copied.return?.();
    }
    report(`DB 분리 대조 완료: ${table} (${count}행)`);
  }
  if (tableExists(sqlite, 'sqlite_sequence', destination)) {
    const placeholders = tables.map(() => '?').join(',');
    sqlite.prepare(`DELETE FROM ${destination}.sqlite_sequence WHERE name IN (${placeholders})`).run(...tables);
    sqlite.prepare(`INSERT INTO ${destination}.sqlite_sequence (name, seq) SELECT name, seq FROM main.sqlite_sequence WHERE name IN (${placeholders})`).run(...tables);
  }
}

/** 서비스의 모든 쓰기를 중지한 배포 준비 단계에서만 단일 DB를 두 파일로 이전한다. */
export function migrateSplitDatabase(databasePath: string, report: (message: string) => void = () => undefined): SplitMigrationResult {
  if (databasePath === ':memory:') throw new Error('메모리 DB는 파일 분리 마이그레이션 대상이 아닙니다');
  const sourcePath = path.resolve(databasePath);
  const journalPath = `${sourcePath}.split-migration.json`;
  if (fs.existsSync(journalPath)) {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as SplitJournal;
    validateJournal(journal, sourcePath);
    publishSplit(journal);
    return { status: 'RECOVERED', backupPath: journal.backupPath };
  }
  if (!fs.existsSync(sourcePath)) {
    if (fs.existsSync(dataDatabasePath(sourcePath))) throw new Error('계산 DB만 존재합니다. 연결된 운영 DB를 복원하세요');
    const handle = openDatabase(sourcePath);
    handle.close();
    return { status: 'NEW' };
  }
  if (fs.lstatSync(sourcePath).isSymbolicLink()) throw new Error('DB 분리 원본은 심볼릭 링크일 수 없습니다');
  const source = new Database(sourcePath, { fileMustExist: true });
  let stagedOperationsPath: string | undefined;
  let stagedDataPath: string | undefined;
  let journal: SplitJournal | undefined;
  try {
    if (!tableExists(source, 'symbols')) {
      source.close();
      const handle = openDatabase(sourcePath);
      handle.close();
      return { status: 'ALREADY_SPLIT' };
    }
    const expected = new Set<string>([...DATA_TABLE_NAMES, ...OPERATIONAL_TABLE_NAMES, '__drizzle_migrations']);
    const tables = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    if (tables.some(({ name }) => !expected.has(name))) throw new Error('소유 DB가 정의되지 않은 테이블이 있어 분리를 중지합니다');
    if (fs.existsSync(dataDatabasePath(sourcePath))) throw new Error('계산 DB 대상 경로가 이미 존재합니다');
    source.pragma('busy_timeout = 1000');
    if (source.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
      throw new Error('DB 분리 전에 기존 서비스를 중지해야 합니다');
    }
    const token = randomUUID();
    stagedOperationsPath = `${sourcePath}.split-${token}.sqlite`;
    stagedDataPath = dataDatabasePath(stagedOperationsPath);
    const staged = openDatabase(stagedOperationsPath);
    const identity = staged.sqlite.prepare('SELECT dataset_id AS id FROM operational_database_state WHERE singleton = 1').get() as { id: string };
    staged.close();
    source.prepare('ATTACH DATABASE ? AS target_ops').run(stagedOperationsPath);
    source.prepare('ATTACH DATABASE ? AS target_data').run(stagedDataPath);
    source.pragma('target_ops.journal_mode = DELETE');
    source.pragma('target_data.journal_mode = DELETE');
    source.pragma('foreign_keys = OFF');
    source.transaction(() => {
      const triggers = source.prepare("SELECT name, sql FROM target_data.sqlite_master WHERE type='trigger'").all() as Array<{ name: string; sql: string }>;
      for (const trigger of triggers) source.exec(`DROP TRIGGER target_data.${sqlIdentifier(trigger.name)}`);
      copyTables(source, OPERATIONAL_TABLE_NAMES, 'target_ops', report);
      copyTables(source, DATA_TABLE_NAMES, 'target_data', report);
      for (const trigger of triggers) source.exec(trigger.sql.replace(/^CREATE TRIGGER\s+/i, 'CREATE TRIGGER target_data.'));
      source.exec('UPDATE target_data.dataset_state SET revision = 1 WHERE singleton = 1');
      report('DB 분리 외래 키 검증');
      if ((source.pragma('target_ops.foreign_key_check') as unknown[]).length || (source.pragma('target_data.foreign_key_check') as unknown[]).length) {
        throw new Error('분리된 DB의 외래 키 검증에 실패했습니다');
      }
    }).exclusive();
    source.close();
    fs.chmodSync(stagedOperationsPath, 0o600);
    fs.chmodSync(stagedDataPath, 0o600);
    report('운영 DB 파일 무결성 검증');
    verifyIdentity(stagedOperationsPath, 'operations', identity.id);
    report('계산 DB 파일 무결성 검증');
    verifyIdentity(stagedDataPath, 'data', identity.id);
    journal = {
      schemaVersion: 1, sourcePath, dataPath: dataDatabasePath(sourcePath),
      stagedOperationsPath, stagedDataPath, backupPath: `${sourcePath}.split-${token}.backup.sqlite`,
      datasetId: identity.id,
    };
    writeJournal(journalPath, journal);
  } catch (error) {
    if (source.open) source.close();
    if (!fs.existsSync(journalPath)) {
      for (const file of [stagedOperationsPath, stagedDataPath]) {
        if (file) for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${file}${suffix}`, { force: true });
      }
    }
    throw error;
  }
  report('검증된 두 DB 활성화');
  publishSplit(journal, true);
  return { status: 'MIGRATED', backupPath: journal.backupPath };
}
