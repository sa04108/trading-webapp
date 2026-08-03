import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';

/**
 * 종목 정렬 지표의 계약 (D-038).
 *
 * 여기서 확인하는 것은 **지표가 없어도 화면이 막히지 않는다** 는 것이다. 증권사 자격
 * 증명이 없는 환경(테스트·CSV 만 쓰는 배포)에서 이 라우트가 4xx 를 내면 종목 목록이
 * 통째로 정렬 불가가 아니라 오류 화면이 된다 — 가나다순으로는 멀쩡히 쓸 수 있는데도.
 *
 * 지표를 실제로 계산하는 규칙(시가총액 = 발행주식수 × 현재가, 랭킹 밖은 null 등)은
 * tests/unit/symbol-metrics-service.test.ts 가 소스를 갈아 끼워 가며 확인한다.
 */
describe('GET /symbols/metrics', () => {
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

  // `/symbols/:code/candles` 와 같은 접두사를 쓴다 — 파라미터 라우트가 먼저 잡으면
  // 「metrics 라는 종목이 없습니다」 404 가 된다. 아래 200 단정이 그 회귀도 겸해서 잡는다.
  it('등록 종목 전체를 답하고, 소스가 없으면 값 대신 null 을 준다', async () => {
    const cookie = await loginCookie();
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols/metrics',
      cookies: { qp_session: cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metrics: Array<{
        code: string;
        marketCap: number | null;
        tradingValue: number | null;
        tradingVolume: number | null;
      }>;
      rankingLimit: number;
    };
    expect(body.metrics.map((metric) => metric.code).sort()).toEqual(['000660', '005930']);
    for (const metric of body.metrics) {
      expect(metric.marketCap).toBeNull();
      expect(metric.tradingValue).toBeNull();
      expect(metric.tradingVolume).toBeNull();
    }
    // 화면이 「거래 지표는 상위 N위까지」를 적을 근거 — 없으면 빈 칸이 버그로 읽힌다
    expect(body.rankingLimit).toBeGreaterThan(0);
  });

  it('등록 종목이 없으면 빈 목록이다', async () => {
    const cookie = await loginCookie();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols/metrics',
      cookies: { qp_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { metrics: unknown[] }).metrics).toEqual([]);
  });


  it('인증 없이는 열리지 않는다', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/symbols/metrics' });
    expect(res.statusCode).toBe(401);
  });
});
