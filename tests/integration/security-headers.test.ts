import { describe, expect } from 'vitest';
import { test } from '../helpers/test-fixtures.js';

describe('보안 헤더', () => {
  test('모든 응답에 보안 헤더를 설정한다', async ({ ctx }) => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health/live' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
