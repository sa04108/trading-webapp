import { and, count, eq, gt } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { loginAttempts, sessions, users } from '../../../shared/db/schema.js';
import type {
  LoginAttemptRepository,
  SessionRecord,
  SessionRepository,
  UserRecord,
  UserRepository,
} from '../application/ports.js';

function toUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
  };
}

export function createSqliteUserRepository(db: AppDatabase): UserRepository {
  return {
    findByUsername(username) {
      const row = db.select().from(users).where(eq(users.username, username)).get();
      return row ? toUserRecord(row) : null;
    },
    findById(id) {
      const row = db.select().from(users).where(eq(users.id, id)).get();
      return row ? toUserRecord(row) : null;
    },
    create(user, nowMs) {
      db.insert(users)
        .values({
          id: user.id,
          username: user.username,
          passwordHash: user.passwordHash,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .run();
    },
    countUsers() {
      const row = db.select({ value: count() }).from(users).get();
      return row?.value ?? 0;
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
