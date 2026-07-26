import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

function sessionCookie(response: { cookies: Array<{ name: string; value: string }> }): string {
  const cookie = response.cookies.find((c) => c.name === 'qp_session');
  if (!cookie) throw new Error('session cookie not set');
  return cookie.value;
}

describe('auth flow (스펙 §14, §16)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('rejects unauthenticated /auth/me and /system/info', async () => {
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(me.statusCode).toBe(401);
    const info = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/info' });
    expect(info.statusCode).toBe(401);
  });

  it('logs in with a password alone, then logs out', async () => {
    const { username, password } = await createTestAdmin(ctx.container);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ status: 'OK' });
    const cookie = sessionCookie(login);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { qp_session: cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().username).toBe(username);

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { qp_session: cookie },
    });
    expect(logout.statusCode).toBe(200);

    const meAfter = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { qp_session: cookie },
    });
    expect(meAfter.statusCode).toBe(401);
  });

  // TOTP 제거(D-014) 후에도 세션 고정 방어는 로그인마다의 새 세션 ID 발급이 담당한다
  it('issues a fresh session id on every login', async () => {
    const { username, password } = await createTestAdmin(ctx.container);

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });

    expect(sessionCookie(first)).not.toBe(sessionCookie(second));
  });

  it('locks the account after 5 failed attempts (스펙 §16 로그인 rate limit)', async () => {
    const { username } = await createTestAdmin(ctx.container);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password: 'wrong-password-123' },
      });
      expect(response.statusCode).toBe(401);
    }

    const locked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'wrong-password-123' },
    });
    expect(locked.statusCode).toBe(429);
  });

  it('denies cross-origin mutations (CSRF, 스펙 §16)', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'x', password: 'y' },
      headers: { origin: 'https://evil.example', host: 'internal.host' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('writes audit logs for login failures', async () => {
    await createTestAdmin(ctx.container);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'operator', password: 'nope-nope-nope' },
    });
    const rows = ctx.container.database.sqlite
      .prepare("SELECT event FROM audit_logs WHERE event = 'auth.login.failure'")
      .all();
    expect(rows.length).toBe(1);
  });
});
