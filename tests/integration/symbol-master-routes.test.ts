import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const isoToBasDd = (iso: string): string => iso.replaceAll('-', '');

/** 정상 거래일 하나를 KOSPI·KOSDAQ 양쪽에 채운다 — universe-routes.test.ts 의 패턴과 같다. */
function seedTradingDay(fake: KrxFakeServer, iso: string, overrides: { listShrs?: string } = {}): void {
  const basDd = isoToBasDd(iso);
  fake.setResponse('stk_isu_base_info', basDd, {
    body: krxEnvelope([
      baseInfoFixture({
        ISU_CD: 'KR7005930003',
        ISU_SRT_CD: '005930',
        ...(overrides.listShrs ? { LIST_SHRS: overrides.listShrs } : {}),
      }),
    ]),
  });
  fake.setResponse('stk_bydd_trd', basDd, {
    body: krxEnvelope([dailyFixture({ ISU_CD: '005930', MKTCAP: '350,000,000,000,000' })]),
  });
  fake.setResponse('ksq_isu_base_info', basDd, {
    body: krxEnvelope([
      baseInfoFixture({ ISU_CD: 'KR7035720002', ISU_SRT_CD: '035720', ISU_NM: '카카오', MKT_TP_NM: 'KOSDAQ' }),
    ]),
  });
  fake.setResponse('ksq_bydd_trd', basDd, {
    body: krxEnvelope([dailyFixture({ ISU_CD: '035720', ISU_NM: '카카오', MKTCAP: '20,000,000,000,000' })]),
  });
}

interface Ctx {
  readonly app: TestApp;
  readonly fake: KrxFakeServer;
  readonly cookie: string;
}

const openCtxs: Ctx[] = [];

async function setup(env: Record<string, string> = {}): Promise<Ctx> {
  const fake = await startKrxFakeServer();
  const app = await createTestApp({
    KRX_BASE_URL: fake.baseUrl,
    KRX_API_KEY: 'test-krx-key',
    ...env,
  });
  const { username, password } = await createTestAdmin(app.container);
  const login = await app.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
  const ctx = { app, fake, cookie };
  openCtxs.push(ctx);
  return ctx;
}

afterEach(async () => {
  for (const ctx of openCtxs.splice(0)) {
    await ctx.app.close();
    await ctx.fake.close();
  }
});

describe('symbol-master routes', () => {
  it('sync 로 수집한 날짜는 universe 조회에서 covered:true 로 왕복된다', async () => {
    const { app, fake, cookie } = await setup();
    seedTradingDay(fake, '2025-01-06');

    const sync = await app.app.inject({
      method: 'POST',
      url: '/api/v1/symbol-master/sync',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-06' },
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({
      requestedDate: '2025-01-06',
      effectiveTradingDate: '2025-01-06',
      ingestedDates: ['2025-01-06'],
    });

    const universe = await app.app.inject({
      method: 'GET',
      url: '/api/v1/symbol-master/universe?date=2025-01-06',
      cookies: { qp_session: cookie },
    });
    expect(universe.statusCode).toBe(200);
    const body = universe.json();
    expect(body.covered).toBe(true);
    expect(body.symbols).toHaveLength(2);
    expect(body.symbols.map((s: { standardCode: string }) => s.standardCode).sort()).toEqual(
      ['KR7005930003', 'KR7035720002'].sort(),
    );
    expect(body.symbols[0]).toMatchObject({ market: expect.stringMatching(/^(KOSPI|KOSDAQ)$/) });
  });

  it('휴장일 sync 요청은 직전 거래일까지 소급한 결과를 돌려준다', async () => {
    const { app, fake, cookie } = await setup();
    seedTradingDay(fake, '2025-01-06');
    // 01-07·01-08 은 별도 세팅 없이 기본값(빈 응답 = 휴장)으로 둔다

    const sync = await app.app.inject({
      method: 'POST',
      url: '/api/v1/symbol-master/sync',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-08' },
    });

    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toEqual({
      requestedDate: '2025-01-08',
      effectiveTradingDate: '2025-01-06',
      ingestedDates: ['2025-01-08', '2025-01-07', '2025-01-06'],
    });

    // 소급 수집이 재구성 앵커를 남겨 이후 조회가 SymbolMasterNotCoveredError 없이 성립한다
    const universe = await app.app.inject({
      method: 'GET',
      url: '/api/v1/symbol-master/universe?date=2025-01-08',
      cookies: { qp_session: cookie },
    });
    expect(universe.statusCode).toBe(200);
    expect(universe.json().covered).toBe(true);
  });

  it('커버되지 않은 날짜는 오류 없이 covered:false 와 빈 배열을 준다', async () => {
    const { app, cookie } = await setup();

    const res = await app.app.inject({
      method: 'GET',
      url: '/api/v1/symbol-master/universe?date=2025-01-06',
      cookies: { qp_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ date: '2025-01-06', covered: false, symbols: [] });
  });

  it('coverage 는 구간·백필 상태를 담는다', async () => {
    const { app, fake, cookie } = await setup();
    seedTradingDay(fake, '2025-01-06');
    await app.app.inject({
      method: 'POST',
      url: '/api/v1/symbol-master/sync',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-06' },
    });

    const res = await app.app.inject({
      method: 'GET',
      url: '/api/v1/symbol-master/coverage',
      cookies: { qp_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ranges).toEqual([{ startDate: '2025-01-06', endDate: '2025-01-06' }]);
    expect(body.tradingDates).toEqual(['2025-01-06']);
    expect(typeof body.lastSyncedAtMs).toBe('number');
    expect(body.backfill).toMatchObject({
      state: 'IDLE',
      cursorDate: null,
      // /symbol-master/sync 는 backfill 을 전혀 건드리지 않는다 — 대상 구간이 없다.
      targetStartDate: null,
      targetEndDate: null,
      error: null,
    });
  });

  it('backfill 은 toDate 를 받으면 그 날짜까지만 채우고 끝난다 (Task 4)', async () => {
    const { app, fake, cookie } = await setup();
    seedTradingDay(fake, '2025-01-06');
    seedTradingDay(fake, '2025-01-07');
    // 2025-01-08 은 세팅하지 않는다 — toDate(01-07) 밖이라 건드리지 않아야 한다.

    const backfill = await app.app.inject({
      method: 'POST',
      url: '/api/v1/symbol-master/backfill',
      cookies: { qp_session: cookie },
      payload: { fromDate: '2025-01-06', toDate: '2025-01-07' },
    });
    expect(backfill.statusCode).toBe(202);

    const readCoverage = async () => {
      const res = await app.app.inject({
        method: 'GET',
        url: '/api/v1/symbol-master/coverage',
        cookies: { qp_session: cookie },
      });
      return res.json();
    };

    await vi.waitFor(
      async () => expect((await readCoverage()).backfill.state).toBe('IDLE'),
      { timeout: 10_000 },
    );

    const body = await readCoverage();
    expect(body.ranges).toEqual([{ startDate: '2025-01-06', endDate: '2025-01-07' }]);
    expect(body.backfill).toMatchObject({
      state: 'IDLE',
      cursorDate: null,
      // 완주해도 마지막 start() 의 대상 구간은 남는다 — 다음 poll 이 "무슨 요청이
      // 끝났는지" 를 알 수 있어야 한다.
      targetStartDate: '2025-01-06',
      targetEndDate: '2025-01-07',
      error: null,
    });
    // toDate 뒤는 아예 조회하지 않았다
    expect(fake.requests.some((r) => r.basDd === '20250108')).toBe(false);
  });

  it('coverage 는 진행 중인 백필의 대상 구간을 완료 전에도 보여준다 (리뷰 finding)', async () => {
    // 위저드가 "지금 도는 백필이 내 요청 범위인지" 를 판단하려면 완료를 기다리지
    // 않고도 targetStartDate/targetEndDate 를 볼 수 있어야 한다 — RUNNING 편승
    // 상황을 설명하려면 이 값이 폴링 도중 내내 노출돼야 하기 때문이다.
    const { app, fake, cookie } = await setup();
    for (let i = 6; i <= 10; i += 1) {
      seedTradingDay(fake, `2025-01-${String(i).padStart(2, '0')}`);
    }

    const backfill = await app.app.inject({
      method: 'POST',
      url: '/api/v1/symbol-master/backfill',
      cookies: { qp_session: cookie },
      payload: { fromDate: '2025-01-06', toDate: '2025-01-10' },
    });
    expect(backfill.statusCode).toBe(202);

    // 완료를 기다리지 않고 바로 읽는다 — targetStartDate/targetEndDate 는 start()
    // 호출 시점에 이미 확정되므로 RUNNING 이든 이미 끝났든 항상 요청한 값과 같다.
    const res = await app.app.inject({
      method: 'GET',
      url: '/api/v1/symbol-master/coverage',
      cookies: { qp_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.backfill.targetStartDate).toBe('2025-01-06');
    expect(body.backfill.targetEndDate).toBe('2025-01-10');

    // 뒷정리 — 백필이 백그라운드에서 계속 돌다 teardown 과 겹치지 않게 끝까지 기다린다.
    //
    // 여유를 넉넉히 둔다: 5일 × 4호출에 RestClient 의 250ms 간격이 걸려 정상에도 5초쯤
    // 걸리고, 기계가 바쁘면 더 밀린다. 그리고 IDLE 이 아닌 채로 끝나면 state 만 보여서는
    // 원인을 알 수 없으므로 backfill 객체 전체를 실패 메시지에 싣는다(FAILED 면 error 가 들어 있다).
    await vi.waitFor(
      async () => {
        const coverage = await app.app.inject({
          method: 'GET',
          url: '/api/v1/symbol-master/coverage',
          cookies: { qp_session: cookie },
        });
        const backfillState = coverage.json().backfill;
        expect(
          backfillState,
          `백필이 IDLE 로 끝나지 않았다: ${JSON.stringify(backfillState)}`,
        ).toMatchObject({ state: 'IDLE' });
      },
      { timeout: 30_000 },
    );
  });

  it('커버 이력이 없으면 lastSyncedAtMs 는 null 이다', async () => {
    const { app, cookie } = await setup();

    const res = await app.app.inject({
      method: 'GET',
      url: '/api/v1/symbol-master/coverage',
      cookies: { qp_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ranges).toEqual([]);
    expect(body.lastSyncedAtMs).toBeNull();
  });

  it('events 는 최대 500행·effectiveDate 내림차순으로 변경 이력을 반환한다', async () => {
    const { app, fake, cookie } = await setup();
    seedTradingDay(fake, '2025-01-06');
    await app.app.inject({
      method: 'POST',
      url: '/api/v1/symbol-master/sync',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-06' },
    });

    // 다음 거래일에 삼성전자 상장주식수가 바뀐다 — SHARES_CHANGED 이벤트가 하나 생긴다.
    seedTradingDay(fake, '2025-01-07', { listShrs: '2,000,000' });
    const sync2 = await app.app.inject({
      method: 'POST',
      url: '/api/v1/symbol-master/sync',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-07' },
    });
    expect(sync2.json()).toMatchObject({
      effectiveTradingDate: '2025-01-07',
      ingestedDates: ['2025-01-07'],
    });

    const res = await app.app.inject({
      method: 'GET',
      url: '/api/v1/symbol-master/events?from=2025-01-01&to=2025-01-31',
      cookies: { qp_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: expect.any(String),
      effectiveDate: '2025-01-07',
      standardCode: 'KR7005930003',
      eventType: 'SHARES_CHANGED',
    });
  });

  it('미인증 요청은 전부 401 이다', async () => {
    const { app } = await setup();

    for (const [method, url] of [
      ['GET', '/api/v1/symbol-master/universe?date=2025-01-06'],
      ['GET', '/api/v1/symbol-master/coverage'],
      ['GET', '/api/v1/symbol-master/events?from=2025-01-01&to=2025-01-31'],
      ['POST', '/api/v1/symbol-master/sync'],
      ['POST', '/api/v1/symbol-master/backfill'],
    ] as const) {
      const res = await app.app.inject({
        method,
        url,
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
