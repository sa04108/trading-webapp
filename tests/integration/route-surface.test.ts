import { describe, expect } from 'vitest';
import { authenticatedTest as it } from '../helpers/test-fixtures.js';
import { registerSymbols } from '../helpers/seed.js';

describe('current HTTP route surface', () => {
  it('대시보드 종목 수는 전체 목록 대신 system/info에서 집계한다', async ({ ctx, cookie }) => {
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/system/info',
      cookies: { qp_session: cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().registeredSymbolCount).toBe(2);
  });

  it('대체됐거나 소비자가 없는 엔드포인트를 노출하지 않는다', async ({ ctx, cookie }) => {
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
