import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';

function factFor(code: string, asOfTsMs: number): Fact {
  return {
    scope: 'SYMBOL',
    key: code,
    field: 'EBIT',
    periodKey: '2025Q1',
    value: 1_000,
    asOfTsMs,
    unit: 'KRW',
    source: 'DART',
  } as Fact;
}

/**
 * 종목 화면이 읽는 계약 (설계 2026-07-31-symbol-as-first-class).
 * 재무 보유 여부가 한 응답에 있어야 200종목에서 행마다 조회를 내지 않는다.
 */
describe('GET /symbols 가 종목 화면에 필요한 것을 한 번에 준다', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  async function loginCookie(): Promise<string> {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    return login.cookies.find((c) => c.name === 'qp_session')!.value;
  }

  async function listSymbols(cookie: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols',
      cookies: { qp_session: cookie },
    });
    return res.json().symbols as Array<{
      code: string;
      market: string;
      name: string | null;
      hasFacts: boolean;
    }>;
  }

  it('등록 직후에는 재무가 없다', async () => {
    const cookie = await loginCookie();
    registerSymbols(ctx.container, 'KR', ['005930']);

    const [symbol] = await listSymbols(cookie);
    expect(symbol?.code).toBe('005930');
    expect(symbol?.hasFacts).toBe(false);
  });

  it('재무는 있고 없음만 답한다 — 저장하면 true 로 바뀐다', async () => {
    const cookie = await loginCookie();
    registerSymbols(ctx.container, 'KR', ['005930']);
    expect((await listSymbols(cookie))[0]?.hasFacts).toBe(false);

    await ctx.container.factRepository.saveFacts([factFor('005930', Date.UTC(2025, 4, 15))]);

    expect((await listSymbols(cookie))[0]?.hasFacts).toBe(true);
  });

  it('재무 보유는 종목별이다 — 한 종목만 받아도 다른 종목은 false 다', async () => {
    const cookie = await loginCookie();
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);
    await ctx.container.factRepository.saveFacts([factFor('005930', Date.UTC(2025, 4, 15))]);

    const symbols = await listSymbols(cookie);
    expect(symbols.find((s) => s.code === '005930')?.hasFacts).toBe(true);
    expect(symbols.find((s) => s.code === '000660')?.hasFacts).toBe(false);
  });
});
