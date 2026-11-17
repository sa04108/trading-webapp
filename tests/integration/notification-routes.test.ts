import { describe, expect } from 'vitest';
import { notifications } from '../../src/server/shared/db/operations-schema.js';
import { authenticatedTest as it } from '../helpers/test-fixtures.js';

describe('notification routes', () => {
  it('requires auth on every endpoint', async ({ ctx }) => {
    for (const [method, url] of [
      ['GET', '/api/v1/notifications'],
      ['GET', '/api/v1/notifications/unread-count'],
      ['GET', '/api/v1/notifications/events'],
      ['POST', '/api/v1/notifications/read-all'],
      ['DELETE', '/api/v1/notifications'],
    ] as const) {
      const res = await ctx.app.inject({ method, url, ...(method === 'DELETE' ? { payload: { all: true } } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('lists newest first and counts unread', async ({ ctx, cookie }) => {
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
      cookies: { session: cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { notifications: Array<{ id: string; read: boolean }> };
    expect(body.notifications.map((n) => n.id)).toEqual(['ntf_b', 'ntf_a']);

    const errors = await ctx.app.inject({ method: 'GET', url: '/api/v1/notifications?severity=error', cookies: { session: cookie } });
    expect(errors.statusCode).toBe(200);
    expect(errors.json().notifications.map((n: { id: string }) => n.id)).toEqual(['ntf_b']);
    const invalid = await ctx.app.inject({ method: 'GET', url: '/api/v1/notifications?severity=invalid', cookies: { session: cookie } });
    expect(invalid.statusCode).toBe(400);

    const countRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      cookies: { session: cookie },
    });
    expect(countRes.json()).toEqual({ count: 1 });
  });

  it('SSE 연결 직후 최초 REST 조회와의 경합을 닫는 sync 이벤트를 보낸다', async ({ ctx, cookie }) => {
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${address}/api/v1/notifications/events`, {
        headers: { cookie: `session=${cookie}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let frame = '';
      while (!/\r?\n\r?\n/.test(frame)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE 연결이 이벤트 전에 종료되었습니다');
        frame += decoder.decode(chunk.value, { stream: true });
      }
      expect(frame).toContain('event: sync');
      expect(frame).toContain('data: {}');
    } finally {
      controller.abort();
      if (reader) await reader.cancel().catch(() => undefined);
    }
  });

  it('marks all read', async ({ ctx, cookie }) => {
    ctx.container.notificationService.create({ type: 'backtest', severity: 'info', title: 'x' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      cookies: { session: cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(ctx.container.notificationService.unreadCount()).toBe(0);
  });

  it('deletes by ids, deletes all, rejects empty selection', async ({ ctx, cookie }) => {
    const service = ctx.container.notificationService;
    const a = service.create({ type: 'backtest', severity: 'info', title: 'a' });
    service.create({ type: 'backtest', severity: 'info', title: 'b' });

    const byIds = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications',
      cookies: { session: cookie },
      payload: { ids: [a.id] },
    });
    expect(byIds.statusCode).toBe(204);
    expect(service.list().map((n) => n.title)).toEqual(['b']);

    const empty = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications',
      cookies: { session: cookie },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const all = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications',
      cookies: { session: cookie },
      payload: { all: true },
    });
    expect(all.statusCode).toBe(204);
    expect(service.list()).toEqual([]);
  });
});
