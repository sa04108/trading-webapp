import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';

describe('current HTTP route surface', () => {
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
    cookie = login.cookies.find((entry) => entry.name === 'qp_session')!.value;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('대시보드 종목 수는 전체 목록 대신 system/info에서 집계한다', async () => {
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/system/info',
      cookies: { qp_session: cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().registeredSymbolCount).toBe(2);
  });

  it('대체됐거나 소비자가 없는 엔드포인트를 노출하지 않는다', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/v1/symbols', undefined],
      ['POST', '/api/v1/symbols', { codes: ['005930'], market: 'KR' }],
      ['POST', '/api/v1/symbols/remove', { codes: ['005930'] }],
      ['GET', '/api/v1/strategies/range-breakout', undefined],
      ['POST', '/api/v1/benchmarks/sync', { benchmarkId: 'KOSPI', date: '2026-08-26' }],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        cookies: { qp_session: cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
