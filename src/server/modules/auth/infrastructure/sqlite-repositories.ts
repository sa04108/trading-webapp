import { and, count, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import type { Logger } from '../../../shared/logger.js';
import { loginAttempts, sessions, users } from '../../../shared/db/schema.js';
import type {
  LoginAttemptRepository,
  SessionRecord,
  SessionRepository,
  UserRecord,
  UserRepository,
} from '../application/ports.js';

/**
 * 손상된 JSON 이 로그인 전체를 500 으로 무너뜨리지 않게 막는다. 이 함수는
 * `findByUsername` 안에서 도는 탓에, 던지면 해당 사용자뿐 아니라 그 경로를 지나는
 * 모든 인증이 죽는다. 파싱 실패는 "복구 코드가 하나도 없다" 로 닫고 경고만 남긴다.
 */
function parseRecoveryCodeHashes(
  json: string | null,
  userId: string,
  logger?: Logger,
): readonly string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('문자열 배열이 아닙니다');
    }
    return parsed as string[];
  } catch (error) {
    logger?.error(
      { module: 'auth', userId, err: error },
      'recovery_code_hashes_json 을 읽을 수 없습니다 — 복구 코드 없음으로 처리합니다',
    );
    return [];
  }
}

function toUserRecord(row: typeof users.$inferSelect, logger?: Logger): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    totpSecret: row.totpSecret,
    totpEnabled: row.totpEnabled,
    totpLastUsedStep: row.totpLastUsedStep,
    recoveryCodeHashes: parseRecoveryCodeHashes(row.recoveryCodeHashesJson, row.id, logger),
  };
}

export function createSqliteUserRepository(db: AppDatabase, logger?: Logger): UserRepository {
  return {
    findByUsername(username) {
      const row = db.select().from(users).where(eq(users.username, username)).get();
      return row ? toUserRecord(row, logger) : null;
    },
    findById(id) {
      const row = db.select().from(users).where(eq(users.id, id)).get();
      return row ? toUserRecord(row, logger) : null;
    },
    create(user, nowMs) {
      db.insert(users)
        .values({
          id: user.id,
          username: user.username,
          passwordHash: user.passwordHash,
          totpSecret: user.totpSecret,
          totpEnabled: user.totpEnabled,
          recoveryCodeHashesJson: JSON.stringify(user.recoveryCodeHashes),
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .run();
    },
    countUsers() {
      const row = db.select({ value: count() }).from(users).get();
      return row?.value ?? 0;
    },
    consumeRecoveryCodeHash(userId, hash, nowMs) {
      // 트랜잭션 안에서 읽고-거르고-쓴다. better-sqlite3 는 동기라 이 블록 안에는
      // await 지점이 없고, 따라서 두 요청이 서로의 스냅샷을 덮어써 이미 소비한
      // 코드를 되살리는 lost update 가 생기지 않는다.
      return db.transaction((tx) => {
        const row = tx
          .select({ json: users.recoveryCodeHashesJson })
          .from(users)
          .where(eq(users.id, userId))
          .get();
        if (!row) return false;
        const current = parseRecoveryCodeHashes(row.json, userId, logger);
        const index = current.indexOf(hash);
        if (index === -1) return false; // 다른 요청이 먼저 소비했다
        const remaining = current.filter((_, i) => i !== index);
        tx.update(users)
          .set({ recoveryCodeHashesJson: JSON.stringify(remaining), updatedAtMs: nowMs })
          .where(eq(users.id, userId))
          .run();
        return true;
      });
    },
    consumeTotpStep(userId, step, nowMs) {
      // 비교와 기록이 한 UPDATE 안에 있다 — 읽고 나서 쓰는 사이에 다른 요청이
      // 같은 스텝을 소비할 틈을 남기지 않는다. changes 가 0 이면 재사용이다.
      const result = db
        .update(users)
        .set({ totpLastUsedStep: step, updatedAtMs: nowMs })
        .where(
          and(
            eq(users.id, userId),
            or(isNull(users.totpLastUsedStep), lt(users.totpLastUsedStep, step)),
          ),
        )
        .run();
      return result.changes > 0;
    },
    setTotp(userId, secret, recoveryCodeHashes, nowMs) {
      db.update(users)
        .set({
          totpSecret: secret,
          totpEnabled: true,
          // 새 secret 은 새 타임스텝 계보다 — 이전 값을 남기면 재발급 직후의
          // 정상 코드가 "이미 쓴 스텝" 으로 걸릴 수 있다
          totpLastUsedStep: null,
          recoveryCodeHashesJson: JSON.stringify(recoveryCodeHashes),
          updatedAtMs: nowMs,
        })
        .where(eq(users.id, userId))
        .run();
    },
    listUsernamesWithoutTotp() {
      return db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.totpEnabled, false))
        .all()
        .map((row) => row.username);
    },
  };
}

export function createSqliteSessionRepository(db: AppDatabase): SessionRepository {
  return {
    create(session: SessionRecord) {
      db.insert(sessions)
        .values({
          id: session.id,
          userId: session.userId,
          pendingTotp: session.pendingTotp,
          createdAtMs: session.createdAtMs,
          lastSeenAtMs: session.lastSeenAtMs,
        })
        .run();
    },
    findById(id) {
      const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
      return row ?? null;
    },
    touch(id, nowMs) {
      db.update(sessions).set({ lastSeenAtMs: nowMs }).where(eq(sessions.id, id)).run();
    },
    delete(id) {
      db.delete(sessions).where(eq(sessions.id, id)).run();
    },
  };
}

export function createSqliteLoginAttemptRepository(db: AppDatabase): LoginAttemptRepository {
  return {
    record(username, ip, success, nowMs) {
      db.insert(loginAttempts)
        .values({ username, ip, success, attemptedAtMs: nowMs })
        .run();
    },
    countRecentFailures(username, sinceMs) {
      const row = db
        .select({ value: count() })
        .from(loginAttempts)
        .where(
          and(
            eq(loginAttempts.username, username),
            eq(loginAttempts.success, false),
            gt(loginAttempts.attemptedAtMs, sinceMs),
          ),
        )
        .get();
      return row?.value ?? 0;
    },
  };
}
