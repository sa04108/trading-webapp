import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { newId } from '../../src/server/shared/ids.js';

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

  it('logs in with a password alone when TOTP is not enrolled, then logs out', async () => {
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

  it('fails closed when totpEnabled is set but totpSecret is null (corrupted state)', async () => {
    const username = 'corrupted-totp';
    const password = 'correct-horse-battery-staple';
    ctx.container.userRepository.create(
      {
        id: newId('usr'),
        username,
        passwordHash: await ctx.container.passwordHasher.hash(password),
        totpSecret: null,
        totpEnabled: true,
        totpLastUsedStep: null,
        recoveryCodeHashes: [],
      },
      ctx.container.clock.now(),
    );

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    expect(login.json()).toEqual({ status: 'TOTP_REQUIRED' });
    const pendingCookie = sessionCookie(login);

    // secret 이 없으니 어떤 토큰도 정답일 수 없다 — fail-closed
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: '000000' },
      cookies: { qp_session: pendingCookie },
    });
    expect(verify.statusCode).toBe(401);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { qp_session: pendingCookie },
    });
    expect(me.statusCode).toBe(401);
  });

  it('counts TOTP verification failures toward the login lockout', async () => {
    const { username, password, totpSecret } = await createTestAdmin(ctx.container, {
      totpEnabled: true,
    });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const pendingCookie = sessionCookie(login);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/totp/verify',
        payload: { token: '000000' },
        cookies: { qp_session: pendingCookie },
      });
      expect(wrong.statusCode).toBe(401);
    }

    // 잠긴 뒤에는 같은 pending 세션에 정답 토큰을 내도 거부된다. 응답은 429 다 —
    // 잠금을 401 로 접으면 운영자가 맞는 코드를 넣고도 "코드가 틀렸다" 만 보게 되고,
    // 같은 상태에서 /auth/login 은 429 를 주므로 두 경로가 서로 다른 말을 하게 된다.
    const correctAfterLock = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: totpToken(totpSecret ?? '') },
      cookies: { qp_session: pendingCookie },
    });
    expect(correctAfterLock.statusCode).toBe(429);

    // 새 로그인 시도도 잠금에 걸린다
    const lockedLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    expect(lockedLogin.statusCode).toBe(429);
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

  it('refuses to reuse a TOTP code that was already redeemed (RFC 6238 §5.2)', async () => {
    const { username, password, totpSecret } = await createTestAdmin(ctx.container, {
      totpEnabled: true,
    });
    const token = totpToken(totpSecret ?? '');

    const firstLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const firstVerify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token },
      cookies: { qp_session: sessionCookie(firstLogin) },
    });
    expect(firstVerify.statusCode).toBe(200);

    // 공격자가 같은 코드를 자기 pending 세션에서 되쓰는 시나리오. window ±1 때문에
    // 코드는 아직 시간상 유효하지만, 이미 소비된 타임스텝이므로 거부되어야 한다.
    const secondLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const replayCookie = sessionCookie(secondLogin);
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token },
      cookies: { qp_session: replayCookie },
    });
    expect(replay.statusCode).toBe(401);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { qp_session: replayCookie },
    });
    expect(me.statusCode).toBe(401);

    const replayAudit = ctx.container.database.sqlite
      .prepare("SELECT event FROM audit_logs WHERE event = 'auth.totp.replay'")
      .all();
    expect(replayAudit.length).toBe(1);
  });

  it('audits a password that stops at the second factor', async () => {
    // 비밀번호가 샜다는 가장 강한 신호다 — 성공도 실패도 아니라는 이유로
    // 아무 기록 없이 지나가면 audit 에도 login_attempts 에도 남지 않는다.
    const { username, password } = await createTestAdmin(ctx.container, { totpEnabled: true });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    expect(login.json()).toEqual({ status: 'TOTP_REQUIRED' });

    const rows = ctx.container.database.sqlite
      .prepare("SELECT event FROM audit_logs WHERE event = 'auth.login.totp-required'")
      .all();
    expect(rows.length).toBe(1);
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
