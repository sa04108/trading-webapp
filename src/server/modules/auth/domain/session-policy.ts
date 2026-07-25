/**
 * 세션 만료 정책 (스펙 §16): 유휴 만료 + 절대 만료.
 * 순수 함수 — IO·프레임워크 의존 없음.
 */
export interface SessionTimestamps {
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number;
}

export interface SessionPolicy {
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
}

export function isSessionExpired(
  session: SessionTimestamps,
  nowMs: number,
  policy: SessionPolicy,
): boolean {
  if (nowMs - session.lastSeenAtMs > policy.idleTimeoutMs) return true;
  if (nowMs - session.createdAtMs > policy.absoluteTimeoutMs) return true;
  return false;
}

/** 로그인 rate limit 판정: 최근 windowMs 내 실패 횟수가 limit 이상이면 잠금 */
export function isLoginLocked(recentFailureCount: number, limit: number): boolean {
  return recentFailureCount >= limit;
}
