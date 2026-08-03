import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifications } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

describe('notification routes', () => {
  let ctx: TestApp;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('requires auth on every endpoint', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/notifications'],
      ['GET', '/api/v1/notifications/unread-count'],
      ['POST', '/api/v1/notifications/read-all'],
      ['DELETE', '/api/v1/notifications'],
    ] as const) {
      const res = await ctx.app.inject({ method, url, ...(method === 'DELETE' ? { payload: { all: true } } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('lists newest first and counts unread', async () => {
    const base = Date.now();
    ctx.container.database.db
      .insert(notifications)
      .values([
        { id: 'ntf_a', type: 'backtest', severity: 'info', title: 'a', read: true, createdAtMs: base - 2 },
        { id: 'ntf_b', type: 'data-sync', severity: 'error', title: 'b', read: false, createdAtMs: base - 1 },
      ])
      .run();

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      cookies: { qp_session: cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { notifications: Array<{ id: string; read: boolean }> };
    expect(body.notifications.map((n) => n.id)).toEqual(['ntf_b', 'ntf_a']);

    const countRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      cookies: { qp_session: cookie },
    });
    expect(countRes.json()).toEqual({ count: 1 });
  });

  it('marks all read', async () => {
    ctx.container.notificationService.create({ type: 'backtest', severity: 'info', title: 'x' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      cookies: { qp_session: cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(ctx.container.notificationService.unreadCount()).toBe(0);
  });

  it('deletes by ids, deletes all, rejects empty selection', async () => {
    const service = ctx.container.notificationService;
    const a = service.create({ type: 'backtest', severity: 'info', title: 'a' });
    service.create({ type: 'backtest', severity: 'info', title: 'b' });

    const byIds = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications',
      cookies: { qp_session: cookie },
      payload: { ids: [a.id] },
    });
    expect(byIds.statusCode).toBe(204);
    expect(service.list().map((n) => n.title)).toEqual(['b']);

    const empty = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications',
      cookies: { qp_session: cookie },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const all = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications',
      cookies: { qp_session: cookie },
      payload: { all: true },
    });
    expect(all.statusCode).toBe(204);
    expect(service.list()).toEqual([]);
  });
});
