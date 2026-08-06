import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';

/**
 * 종목 일괄 등록 — 화면의 「추가」가 쉼표로 구분한 코드를 목록으로 보낸다.
 *
 * 라우트가 단건과 일괄을 나누지 않는다: 단건은 길이 1 목록이다. 나누면 이름 조회·시장
 * 검증·감사 기록이 두 곳에 생기고 한쪽만 고쳐진다.
 */
describe('POST /symbols — 단건·일괄 공용 등록', () => {
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
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
  });
  afterEach(async () => {
    await ctx.close();
  });

  const add = (codes: string[], market = 'KR') =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols',
      cookies: { qp_session: cookie },
      payload: { codes, market },
    });

  const listCodes = async (): Promise<string[]> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols',
      cookies: { qp_session: cookie },
    });
    return (res.json().symbols as Array<{ code: string }>).map((symbol) => symbol.code);
  };

  it('단건은 길이 1 목록으로 들어간다', async () => {
    const res = await add(['005930']);
    expect(res.statusCode).toBe(201);
    expect(res.json().added).toHaveLength(1);
    expect(res.json().added[0].code).toBe('005930');
    expect(res.json().skipped).toEqual([]);
    expect(await listCodes()).toEqual(['005930']);
  });

  it('여러 종목을 한 요청에 등록한다', async () => {
    const res = await add(['005930', '000660', '035720']);
    expect(res.statusCode).toBe(201);
    expect(res.json().added).toHaveLength(3);
    expect((await listCodes()).sort()).toEqual(['000660', '005930', '035720']);
  });

  it('응답 항목은 목록 계약과 같은 모양이다 — 화면이 두 형태를 다루지 않게', async () => {
    const res = await add(['005930']);
    const [symbol] = res.json().added as Array<Record<string, unknown>>;
    expect(symbol).toMatchObject({ code: '005930', market: 'KR', hasFacts: false });
    expect(symbol!.slices).toHaveLength(2);
  });

  /**
   * 부분 성공을 인정한다. 20종목 중 3종목이 이미 있을 때 전체를 되돌리면 사용자가
   * 목록에서 그 3개를 손으로 지우고 다시 붙여야 한다.
   */
  it('이미 등록된 종목은 건너뛰고 나머지는 넣는다 — 무엇이 빠졌는지 응답에 적는다', async () => {
    registerSymbols(ctx.container, 'KR', ['000660']);

    const res = await add(['005930', '000660', '035720']);
    expect(res.statusCode).toBe(201);
    expect((res.json().added as Array<{ code: string }>).map((s) => s.code)).toEqual([
      '005930',
      '035720',
    ]);
    expect(res.json().skipped).toHaveLength(1);
    expect(res.json().skipped[0].code).toBe('000660');
    expect(res.json().skipped[0].reason).toContain('이미 등록된 종목');
  });

  it('하나도 못 넣으면 201 이 아니다 — 빈 성공은 화면에 거짓 토스트를 띄운다', async () => {
    registerSymbols(ctx.container, 'KR', ['005930']);

    const res = await add(['005930']);
    expect(res.statusCode).toBe(409);
    expect(res.json().added).toEqual([]);
    expect(res.json().error).toContain('이미 등록된 종목');
  });

  it('같은 코드를 두 번 보내도 한 번만 등록한다 — 두 번 붙였다고 실패시킬 이유가 없다', async () => {
    const res = await add(['005930', '005930']);
    expect(res.statusCode).toBe(201);
    expect(res.json().added).toHaveLength(1);
    expect(res.json().skipped).toEqual([]);
  });

  it('형식이 틀린 코드가 섞이면 요청 전체를 거부한다 — 화면이 먼저 막는 자리다', async () => {
    const res = await add(['005930', '한글코드']);
    expect(res.statusCode).toBe(400);
    expect(await listCodes()).toEqual([]);
  });

  it('빈 목록은 400 이다', async () => {
    expect((await add([])).statusCode).toBe(400);
  });

  it('상한(1000종목)을 넘는 목록은 400 이다', async () => {
    const codes = Array.from({ length: 1001 }, (_, i) => String(i).padStart(6, '0'));
    expect((await add(codes)).statusCode).toBe(400);
  });

  it('미지원 시장은 등록 자체를 거부한다 (D-006·D-027)', async () => {
    const res = await add(['AAPL'], 'US');
    expect(res.statusCode).toBe(409);
    expect(res.json().added).toEqual([]);
    expect(await listCodes()).toEqual([]);
  });

  it('알 수 없는 시장 값은 400 이다', async () => {
    expect((await add(['005930'], 'JP')).statusCode).toBe(400);
  });

  it('인증 없이는 등록할 수 없다', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols',
      payload: { codes: ['005930'], market: 'KR' },
    });
    expect(res.statusCode).toBe(401);
  });
});
