import { createHash } from 'node:crypto';
import { describe, expect, vi } from 'vitest';
import { authenticatedTest as it } from '../helpers/test-fixtures.js';
import { createTestAdmin } from '../helpers/test-app.js';

describe('OpenAPI 토큰 인증', () => {
  it('기본 1년 토큰을 해시로 저장하고 Bearer 실행·조회 및 즉시 폐기를 지원한다', async ({ ctx, cookie }) => {
    const cookies = { session: cookie };
    const issued = await ctx.app.inject({ method: 'POST', url: '/api/v1/openapi-tokens', cookies, payload: { name: '로컬 AI' } });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.headers['cache-control']).toBe('no-store');
    const { token, record } = issued.json();
    expect(token).toMatch(/^qpo_[A-Za-z0-9_-]{43}$/);
    expect(record.expiresAtMs - record.createdAtMs).toBe(365 * 86400000);
    expect(record.scope).toBe('READ_WRITE');
    const stored = ctx.container.database.sqlite.prepare('SELECT * FROM openapi_tokens WHERE id=?').get(record.id) as { token_hash: string };
    expect(stored.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(ctx.container.database.sqlite.prepare('SELECT * FROM audit_logs').all())).not.toContain(token);
    const headers = { authorization: `Bearer ${token}` };
    const reference = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/api-reference', headers });
    expect(reference.statusCode, reference.body).toBe(200);
    const wizard = await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/wizards', headers, payload: {} });
    expect(wizard.statusCode, wizard.body).toBe(201);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/wizards/${wizard.json().wizard.id}`, cookies })).statusCode).toBe(200);
    const listed = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi-tokens', cookies });
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain(stored.token_hash);
    expect(listed.json().tokens[0].lastUsedAtMs).toBeGreaterThanOrEqual(record.createdAtMs);
    for (const [method, url] of [['GET', '/api/v1/openapi-tokens'], ['POST', '/api/v1/openapi-tokens'], ['DELETE', `/api/v1/openapi-tokens/${record.id}`], ['POST', '/api/v1/agents']] as const) {
      expect((await ctx.app.inject({ method, url, headers, payload: method === 'POST' ? { name: 'escalation' } : undefined })).statusCode).toBe(403);
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/system/info', cookies, headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/agents/datasets/1', headers })).statusCode).toBe(401);
    const agent = ctx.container.agentCoordinator.registry.issue('isolated');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/system/info', headers: { authorization: `Bearer ${agent.token}` } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/openapi-tokens/${record.id}`, cookies })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/system/info', headers })).statusCode).toBe(401);
  });

  it('조회 전용 권한과 소유자 격리, 정확한 만료 시점을 지킨다', async ({ ctx, cookie }) => {
    const cookies = { session: cookie };
    const issued = await ctx.app.inject({ method: 'POST', url: '/api/v1/openapi-tokens', cookies, payload: { name: '조회 도구', scope: 'READ_ONLY', expiresInDays: 1 } });
    expect(issued.statusCode).toBe(201);
    const { token, record } = issued.json();
    const headers = { authorization: `Bearer ${token}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/system/info', headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/wizards', headers, payload: {} })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PATCH', url: '/api/v1/symbols/library/005930', headers, payload: { favorite: true } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/v1/backtests/missing', headers })).statusCode).toBe(403);
    const other = await createTestAdmin(ctx.container, { username: 'token-other' });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: other.username, password: other.password } });
    const otherCookies = { session: login.cookies.find(c => c.name === 'session')!.value };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi-tokens', cookies: otherCookies })).json().tokens).toEqual([]);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/openapi-tokens/${record.id}`, cookies: otherCookies })).statusCode).toBe(404);
    for (const expiresInDays of [0, 3651, 1.5]) expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/openapi-tokens', cookies, payload: { name: 'invalid', expiresInDays } })).statusCode).toBe(400);
    const clock = vi.spyOn(ctx.container.clock, 'now');
    try {
      clock.mockReturnValue(record.expiresAtMs - 1);
      expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/system/info', headers })).statusCode).toBe(200);
      clock.mockReturnValue(record.expiresAtMs);
      expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/system/info', headers })).statusCode).toBe(401);
    } finally { clock.mockRestore(); }
  });
});
