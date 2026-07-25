import * as OTPAuth from 'otpauth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

function sessionCookie(response: { cookies: Array<{ name: string; value: string }> }): string {
  const cookie = response.cookies.find((c) => c.name === 'qp_session');
  if (!cookie) throw new Error('session cookie not set');
  return cookie.value;
}

function totpToken(secret: string): string {
  return new OTPAuth.TOTP({
    issuer: 'Quant Platform',
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
  }).generate();
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

  it('logs in without TOTP when disabled, then logs out', async () => {
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

  it('requires TOTP as a second step and rotates the session id', async () => {
    const { username, password, totpSecret } = await createTestAdmin(ctx.container, {
      totpEnabled: true,
    });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    expect(login.json()).toEqual({ status: 'TOTP_REQUIRED' });
    const pendingCookie = sessionCookie(login);

    // TOTP 완료 전에는 인증되지 않는다
    const mePending = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { qp_session: pendingCookie },
    });
    expect(mePending.statusCode).toBe(401);

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: '000000' },
      cookies: { qp_session: pendingCookie },
    });
    expect(wrong.statusCode).toBe(401);

    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: totpToken(totpSecret ?? '') },
      cookies: { qp_session: pendingCookie },
    });
    expect(verify.statusCode).toBe(200);
    const fullCookie = sessionCookie(verify);
    expect(fullCookie).not.toBe(pendingCookie); // 세션 회전

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { qp_session: fullCookie },
    });
    expect(me.statusCode).toBe(200);
  });

  it('accepts a recovery code once', async () => {
    const recoveryCodes = ['aaaa11112222', 'bbbb33334444'];
    const { username, password } = await createTestAdmin(ctx.container, {
      totpEnabled: true,
      recoveryCodes,
    });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const pendingCookie = sessionCookie(login);

    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: recoveryCodes[0] },
      cookies: { qp_session: pendingCookie },
    });
    expect(verify.statusCode).toBe(200);

    // 같은 복구 코드는 재사용 불가
    const secondLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const secondPending = sessionCookie(secondLogin);
    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: recoveryCodes[0] },
      cookies: { qp_session: secondPending },
    });
    expect(reuse.statusCode).toBe(401);
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
