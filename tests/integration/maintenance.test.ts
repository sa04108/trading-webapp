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
    const options = {
      idleTimeoutMs: 12 * HOUR,
      absoluteTimeoutMs: 7 * DAY,
      auditLogRetentionMs: 90 * DAY,
    };

    db.insert(users)
      .values({
        id: 'usr_prune',
        username: 'prune-user',
        passwordHash: 'x',
        createdAtMs: now,
        updatedAtMs: now,
      })
      .run();
    db.insert(sessions)
      .values([
        // 유휴 만료 / 절대 만료 / 유효
        { id: 's_idle', userId: 'usr_prune', createdAtMs: now - HOUR, lastSeenAtMs: now - 13 * HOUR },
        { id: 's_abs', userId: 'usr_prune', createdAtMs: now - 8 * DAY, lastSeenAtMs: now },
        { id: 's_live', userId: 'usr_prune', createdAtMs: now, lastSeenAtMs: now },
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

    pruneExpiredRows(db, now, options);

    expect(db.select().from(sessions).all().map((s) => s.id)).toEqual(['s_live']);
    expect(db.select().from(loginAttempts).all()).toHaveLength(1);
    expect(db.select().from(auditLogs).all().map((a) => a.event)).toEqual(['recent']);
  });

  it('keeps every audit log when retention is disabled (D-011)', () => {
    const db = ctx.container.database.db;
    const now = Date.now();

    db.insert(auditLogs)
      .values([
        { actor: 'a', event: 'ancient', detailJson: null, createdAtMs: now - 3650 * DAY },
        { actor: 'a', event: 'recent', detailJson: null, createdAtMs: now - DAY },
      ])
      .run();

    pruneExpiredRows(db, now, {
      idleTimeoutMs: 12 * HOUR,
      absoluteTimeoutMs: 7 * DAY,
      auditLogRetentionMs: 0,
    });

    expect(db.select().from(auditLogs).all().map((a) => a.event)).toEqual(['ancient', 'recent']);
  });
});
