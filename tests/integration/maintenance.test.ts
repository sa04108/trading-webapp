import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneExpiredRows } from '../../src/server/shared/db/maintenance.js';
import { auditLogs, loginAttempts, sessions, users } from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('DB maintenance (무한 증가 방지)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('prunes expired sessions, stale login attempts, and old audit logs', () => {
    const db = ctx.container.database.db;
    const now = Date.now();
    const timeouts = { idleTimeoutMs: 12 * HOUR, absoluteTimeoutMs: 7 * DAY };

    db.insert(users)
      .values({
        id: 'usr_prune',
        username: 'prune-user',
        passwordHash: 'x',
        totpSecret: null,
        totpEnabled: false,
        recoveryCodeHashesJson: '[]',
        createdAtMs: now,
        updatedAtMs: now,
      })
      .run();
    db.insert(sessions)
      .values([
        // 유휴 만료 (대기 TOTP 세션 포함) / 절대 만료 / 유효
        { id: 's_idle', userId: 'usr_prune', pendingTotp: true, createdAtMs: now - HOUR, lastSeenAtMs: now - 13 * HOUR },
        { id: 's_abs', userId: 'usr_prune', pendingTotp: false, createdAtMs: now - 8 * DAY, lastSeenAtMs: now },
        { id: 's_live', userId: 'usr_prune', pendingTotp: false, createdAtMs: now, lastSeenAtMs: now },
      ])
      .run();
    db.insert(loginAttempts)
      .values([
        { username: 'a', ip: '1.1.1.1', success: false, attemptedAtMs: now - 2 * DAY },
        { username: 'a', ip: '1.1.1.1', success: false, attemptedAtMs: now - HOUR },
      ])
      .run();
    db.insert(auditLogs)
      .values([
        { actor: 'a', event: 'old', detailJson: null, createdAtMs: now - 91 * DAY },
        { actor: 'a', event: 'recent', detailJson: null, createdAtMs: now - DAY },
      ])
      .run();

    pruneExpiredRows(db, now, timeouts);

    expect(db.select().from(sessions).all().map((s) => s.id)).toEqual(['s_live']);
    expect(db.select().from(loginAttempts).all()).toHaveLength(1);
    expect(db.select().from(auditLogs).all().map((a) => a.event)).toEqual(['recent']);
  });
});
