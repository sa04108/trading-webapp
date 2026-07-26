import { lt, or } from 'drizzle-orm';
import type { AppDatabase } from './database.js';
import { auditLogs, loginAttempts, sessions } from './schema.js';

/** 로그인 시도는 잠금 판정 창(15분)에만 쓰인다 — 하루면 충분하고 감사 기록은 audit_logs 가 담당 */
const LOGIN_ATTEMPT_RETENTION_MS = 24 * 3_600_000;

export interface PruneOptions {
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
  /**
   * 감사 로그 보존 기간 (D-011). 0 이면 삭제하지 않는다 —
   * §16 이 요구하는 것은 기록이지 파기가 아니므로 파기는 운영자가 명시적으로 정한다.
   */
  readonly auditLogRetentionMs: number;
}

/**
 * 무한 증가 방지 정리 (부팅 시 + 주기 실행).
 * 만료 세션·오래된 로그인 시도·보존 기간 지난 감사 로그를 삭제한다.
 */
export function pruneExpiredRows(db: AppDatabase, nowMs: number, options: PruneOptions): void {
  db.delete(sessions)
    .where(
      or(
        lt(sessions.lastSeenAtMs, nowMs - options.idleTimeoutMs),
        lt(sessions.createdAtMs, nowMs - options.absoluteTimeoutMs),
      ),
    )
    .run();
  db.delete(loginAttempts)
    .where(lt(loginAttempts.attemptedAtMs, nowMs - LOGIN_ATTEMPT_RETENTION_MS))
    .run();
  if (options.auditLogRetentionMs > 0) {
    db.delete(auditLogs)
      .where(lt(auditLogs.createdAtMs, nowMs - options.auditLogRetentionMs))
      .run();
  }
}
