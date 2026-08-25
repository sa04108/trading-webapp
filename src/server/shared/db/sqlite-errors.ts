const RETRYABLE_SQLITE_CODES = ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR'] as const;
const UNAVAILABLE_STORAGE_CODES = [
  ...RETRYABLE_SQLITE_CODES,
  'SQLITE_FULL',
  'SQLITE_READONLY',
  'SQLITE_CANTOPEN',
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EIO',
  'EMFILE',
  'ENFILE',
  'EACCES',
  'EPERM',
  'EAGAIN',
  'ENOMEM',
] as const;

function hasCode(error: unknown, codes: readonly string[]): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 10 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (typeof current !== 'object') return false;
    const value = current as { readonly code?: unknown; readonly cause?: unknown };
    const actualCode = value.code;
    if (
      typeof actualCode === 'string'
      && codes.some((code) => actualCode === code || actualCode.startsWith(`${code}_`))
    ) return true;
    current = value.cause;
  }
  return false;
}

/** cause chain에 숨어 있는 SQLite의 일시적 lock/I/O 실패까지 찾는다. */
export function isRetryableSqliteError(error: unknown): boolean {
  if (hasCode(error, RETRYABLE_SQLITE_CODES)) return true;
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 10 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (typeof current !== 'object') return false;
    const value = current as { readonly code?: unknown; readonly message?: unknown; readonly cause?: unknown };
    if (
      typeof value.message === 'string'
      && /database is (?:busy|locked)|disk I\/O error/i.test(value.message)
    ) return true;
    current = value.cause;
  }
  return false;
}

/** 중앙 DB·업로드 파일·import child 자원을 현재 쓸 수 없어 동일 artifact 재시도가 필요한 오류. */
export function isPersistenceUnavailableError(error: unknown): boolean {
  if (hasCode(error, UNAVAILABLE_STORAGE_CODES) || isRetryableSqliteError(error)) return true;
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 10 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (typeof current !== 'object') return false;
    const value = current as { readonly message?: unknown; readonly cause?: unknown };
    if (
      typeof value.message === 'string'
      && /database or disk is full|database is read-only|readonly database/i.test(value.message)
    ) return true;
    current = value.cause;
  }
  return false;
}
