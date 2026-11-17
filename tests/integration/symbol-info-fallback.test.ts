import { describe, expect } from 'vitest';
import { createTestAdmin, type TestApp } from '../helpers/test-app.js';
import { test as it } from '../helpers/test-fixtures.js';
import { registerSymbols } from '../helpers/seed.js';
import Fastify from 'fastify';
import { pino } from 'pino';
import { SymbolInfoService } from '../../src/server/modules/market-data/application/symbol-info-service.js';
import { registerSymbolRoutes } from '../../src/server/modules/market-data/presentation/symbol-routes.js';
import { createTossStockInfoSource } from '../../src/server/modules/broker/infrastructure/toss/toss-stock-info-source.js';

describe('GET /symbols/info — 로컬 종목 마스터 폴백', () => {
  async function loginCookie(ctx: TestApp): Promise<string> {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    return login.cookies.find((c) => c.name === 'session')!.value;
  }

  it(
    '증권사가 코드 하나(같은 청크)를 통째로 실패시켜도 나머지 종목 이름은 정상 반환하고, ' +
      '실패한 종목도 로컬 이름이 있으면 그것으로 채운다',
    async ({ ctx }) => {
      const symbols = ['999999', ...Array.from({ length: 199 }, (_, i) => String(i).padStart(6, '0')), '005930'];
      registerSymbols(ctx.container, 'KR', ['999999']);
      ctx.container.symbolService.setName('999999', '상장폐지테스트');
      const logger = pino({ enabled: false });
      const calls: string[] = [];
      const source = createTossStockInfoSource({ baseUrl: 'https://toss.test', clientId: 'client', clientSecret: 'secret' }, logger, {
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.includes('oauth2')) return Response.json({ access_token: 'token', token_type: 'Bearer', expires_in: 86400 });
          calls.push(url.searchParams.get('symbols') ?? '');
          if (calls.length === 1) return Response.json({ error: 'not found' }, { status: 404 });
          return Response.json({ result: [{ symbol: '005930', name: '삼성전자', market: 'KOSPI' }] });
        },
        sleep: async () => {},
      });
      const service = new SymbolInfoService(source, ctx.container.clock, logger, ctx.container.symbolService);
      const app = Fastify();
      registerSymbolRoutes(app, service, async () => {});
      try {
        const res = await app.inject({ method: 'GET', url: `/symbols/info?symbols=${symbols.join(',')}` });
        expect(res.statusCode).toBe(200);
        const byCode = new Map((res.json().stocks as Array<{ symbol: string; name: string }>).map((stock) => [stock.symbol, stock.name]));
        expect(byCode.get('999999')).toBe('상장폐지테스트');
        expect(byCode.get('005930')).toBe('삼성전자');
        expect(calls).toEqual([symbols.slice(0, 200).join(','), '005930']);
      } finally { await app.close(); }
    },
  );

  it('증권사 자격 증명이 미설정이어도 로컬 종목 마스터의 이름은 그대로 나온다', async ({ ctx }) => {
    const cookie = await loginCookie(ctx);
    // 이 테스트 앱은 TOSS_CLIENT_ID/SECRET 을 넘기지 않으므로 소스가 비활성(미설정) 상태다
    registerSymbols(ctx.container, 'KR', ['005930']);
    ctx.container.symbolService.setName('005930', '로컬종목마스터이름');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols/info?symbols=005930',
      cookies: { session: cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().stocks).toEqual([
      {
        symbol: '005930',
        name: '로컬종목마스터이름',
        englishName: null,
        market: 'KR',
        status: '',
        sharesOutstanding: null,
      },
    ]);
  });

  it('로컬에도 이름이 없는 코드는 여전히 빈 목록이다 (기존 계약 유지)', async ({ ctx }) => {
    const cookie = await loginCookie(ctx);
    registerSymbols(ctx.container, 'KR', ['005930']); // 이름 없이 등록

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols/info?symbols=005930',
      cookies: { session: cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().stocks).toEqual([]);
  });
});
