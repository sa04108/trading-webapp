import { lt, or } from 'drizzle-orm';
import type { AppDatabase } from './database.js';
import { auditLogs, loginAttempts, sessions } from './schema.js';

/** 로그인 시도는 잠금 판정 창(15분)에만 쓰인다 — 하루면 충분하고 감사 기록은 audit_logs 가 담당 */
const LOGIN_ATTEMPT_RETENTION_MS = 24 * 3_600_000;
/** 감사 로그 보존 기간 (스펙 §16 감사 목적, 개인 운영 기준 90일) */
const AUDIT_LOG_RETENTION_MS = 90 * 86_400_000;

export interface SessionTimeouts {
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
}

/**
 * 무한 증가 방지 정리 (부팅 시 + 주기 실행).
 * 만료 세션(대기 TOTP 포함)·오래된 로그인 시도·보존 기간 지난 감사 로그를 삭제한다.
 */
export function pruneExpiredRows(
  db: AppDatabase,
  nowMs: number,
  timeouts: SessionTimeouts,
): void {
  db.delete(sessions)
    .where(
      or(
        lt(sessions.lastSeenAtMs, nowMs - timeouts.idleTimeoutMs),
        lt(sessions.createdAtMs, nowMs - timeouts.absoluteTimeoutMs),
      ),
    )
    .run();
  db.delete(loginAttempts)
    .where(lt(loginAttempts.attemptedAtMs, nowMs - LOGIN_ATTEMPT_RETENTION_MS))
    .run();
  db.delete(auditLogs)
    .where(lt(auditLogs.createdAtMs, nowMs - AUDIT_LOG_RETENTION_MS))
    .run();
}
