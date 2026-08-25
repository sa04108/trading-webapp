import { describe, expect, it } from 'vitest';
import {
  isPersistenceUnavailableError,
  isRetryableSqliteError,
} from '../../src/server/shared/db/sqlite-errors.js';

describe('isRetryableSqliteError', () => {
  it('cause chain의 BUSY/LOCKED/IOERR 확장 코드를 재시도 가능으로 분류한다', () => {
    expect(isRetryableSqliteError(new Error('outer', {
      cause: Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }),
    }))).toBe(true);
    expect(isRetryableSqliteError(Object.assign(new Error('locked'), {
      code: 'SQLITE_LOCKED_SHAREDCACHE',
    }))).toBe(true);
    expect(isRetryableSqliteError(Object.assign(new Error('io'), {
      code: 'SQLITE_IOERR_READ',
    }))).toBe(true);
  });

  it('artifact 형식 오류나 일반 SQLite 오류는 재시도 가능으로 오인하지 않는다', () => {
    expect(isRetryableSqliteError(new Error('manifest mismatch'))).toBe(false);
    expect(isRetryableSqliteError(Object.assign(new Error('no table'), {
      code: 'SQLITE_ERROR',
    }))).toBe(false);
  });
});

describe('isPersistenceUnavailableError', () => {
  it.each([
    'SQLITE_FULL',
    'SQLITE_READONLY_DBMOVED',
    'SQLITE_CANTOPEN',
    'ENOSPC',
    'EROFS',
    'EIO',
    'EACCES',
    'EPERM',
    'EAGAIN',
    'ENOMEM',
  ])(
    '%s 저장소 오류를 동일 artifact 재시도 대상으로 분류한다',
    (code) => {
      expect(isPersistenceUnavailableError(Object.assign(new Error(code), { code }))).toBe(true);
    },
  );

  it('artifact 손상 코드는 저장소 일시 불가로 오인하지 않는다', () => {
    expect(isPersistenceUnavailableError(
      Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }),
    )).toBe(false);
    expect(isPersistenceUnavailableError(
      Object.assign(new Error('no such table: symbol_master_versions'), { code: 'SQLITE_ERROR' }),
    )).toBe(false);
  });

  it('driver가 code를 잃어도 SQLite의 정확한 저장 공간 오류 문구는 보존한다', () => {
    expect(isPersistenceUnavailableError(new Error('database or disk is full'))).toBe(true);
  });
});
