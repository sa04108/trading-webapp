import { afterEach, describe, expect, it } from 'vitest';
import {
  symbols,
  universeSnapshots,
  universeSnapshotSymbols,
} from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const isoToBasDd = (iso: string): string => iso.replaceAll('-', '');

/** 정상 거래일 하나를 KOSPI·KOSDAQ 양쪽에 채운다 — 기본정보 1건 + 일별 1건씩. */
function seedTradingDay(fake: KrxFakeServer, iso: string): void {
  const basDd = isoToBasDd(iso);
  fake.setResponse('stk_isu_base_info', basDd, {
    body: krxEnvelope([baseInfoFixture({ ISU_CD: 'KR7005930003', ISU_SRT_CD: '005930' })]),
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

/** 휴장일 — KOSPI 일별 응답이 빈 배열이라 findEffectiveTradingDate 가 이전 날로 넘어간다. */
function seedNonTradingDay(fake: KrxFakeServer, iso: string): void {
  fake.setResponse('stk_bydd_trd', isoToBasDd(iso), { body: krxEnvelope([]) });
}

interface Ctx {
  readonly app: TestApp;
  readonly fake: KrxFakeServer;
  readonly cookie: string;
}

const openCtxs: Ctx[] = [];

async function setupUniverse(env: Record<string, string> = {}): Promise<Ctx> {
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

describe('universe routes', () => {
  it('키 미설정이면 status.available=false 고 preview 는 409 다 — 외부 호출 없음', async () => {
    const fake = await startKrxFakeServer();
    const app = await createTestApp({ KRX_BASE_URL: fake.baseUrl });
    const { username, password } = await createTestAdmin(app.container);
    const login = await app.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    const status = await app.app.inject({
      method: 'GET',
      url: '/api/v1/universe/historical/status',
      cookies: { qp_session: cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ available: false });

    const preview = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-06' },
    });
    expect(preview.statusCode).toBe(409);
    expect(fake.requests).toHaveLength(0);

    await app.close();
    await fake.close();
  });

  it('미리보기는 DB 에 아무것도 쓰지 않는다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    seedTradingDay(fake, '2025-01-06');

    const res = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-06' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.previewId).toBeTruthy();
    expect(body.effectiveTradingDate).toBe('2025-01-06');
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0]).toMatchObject({ marketCapKrw: expect.any(String) });
    expect(body.attribution).toBe('한국거래소 통계정보');

    expect(app.container.database.db.select().from(symbols).all()).toEqual([]);
    expect(app.container.database.db.select().from(universeSnapshots).all()).toEqual([]);
  });

  it('휴장일 기준일은 이전 거래일로 해소되고 두 날짜가 응답에 있다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    seedNonTradingDay(fake, '2025-01-05');
    seedNonTradingDay(fake, '2025-01-04');
    seedTradingDay(fake, '2025-01-03');

    const res = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-05' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestedDate).toBe('2025-01-05');
    expect(body.effectiveTradingDate).toBe('2025-01-03');
  });

  it('스냅샷 저장이 universe_snapshots·값 행·symbols 등록을 만든다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    seedTradingDay(fake, '2025-01-06');

    const previewRes = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-06' },
    });
    const preview = previewRes.json();

    const snapshotRes = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/snapshots',
      cookies: { qp_session: cookie },
      payload: {
        previewId: preview.previewId,
        standardCodes: preview.candidates.map((c: { standardCode: string }) => c.standardCode),
        selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
      },
    });

    expect(snapshotRes.statusCode).toBe(201);
    const { snapshot } = snapshotRes.json();
    expect(snapshot.selectedCount).toBe(2);
    expect(snapshot.symbols).toHaveLength(2);

    expect(app.container.database.db.select().from(universeSnapshots).all()).toHaveLength(1);
    expect(app.container.database.db.select().from(universeSnapshotSymbols).all()).toHaveLength(2);
    expect(app.container.database.db.select().from(symbols).all()).toHaveLength(2);
  });

  it('만료 previewId 저장은 409 와 재조회 안내다', async () => {
    const { app, cookie } = await setupUniverse();

    const res = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/snapshots',
      cookies: { qp_session: cookie },
      payload: {
        previewId: 'uvp_does_not_exist',
        standardCodes: ['KR7005930003'],
        selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('다시 조회');
    expect(app.container.database.db.select().from(universeSnapshots).all()).toEqual([]);
  });

  it('한 시장 실패 시 502 고 이후 DB 상태가 깨끗하다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    const basDd = isoToBasDd('2025-01-07');
    fake.setResponse('stk_bydd_trd', basDd, {
      body: krxEnvelope([dailyFixture({ ISU_CD: '005930', MKTCAP: '350,000,000,000,000' })]),
    });
    fake.setResponse('stk_isu_base_info', basDd, {
      body: krxEnvelope([baseInfoFixture({ ISU_CD: 'KR7005930003', ISU_SRT_CD: '005930' })]),
    });
    fake.setResponse('ksq_bydd_trd', basDd, {
      body: krxEnvelope([dailyFixture({ ISU_CD: '035720', ISU_NM: '카카오', MKTCAP: '20,000,000,000,000' })]),
    });
    // KOSDAQ 기본정보는 계약과 다른 응답 (OutBlock_1 누락) — KrxContractError
    fake.setResponse('ksq_isu_base_info', basDd, { body: { resultCode: 'SUCCESS' } });

    const res = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-07' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).not.toMatch(/resultCode|SUCCESS/);
    expect(app.container.database.db.select().from(symbols).all()).toEqual([]);
    expect(app.container.database.db.select().from(universeSnapshots).all()).toEqual([]);
  });

  it('저장한 스냅샷을 목록·상세로 조회한다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    seedTradingDay(fake, '2025-01-06');
    const previewRes = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-06' },
    });
    const preview = previewRes.json();
    const created = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/snapshots',
      cookies: { qp_session: cookie },
      payload: {
        previewId: preview.previewId,
        standardCodes: [preview.candidates[0].standardCode],
        selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
      },
    });
    const { snapshot } = created.json();

    const list = await app.app.inject({
      method: 'GET',
      url: '/api/v1/universe/snapshots',
      cookies: { qp_session: cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().snapshots.map((s: { id: string }) => s.id)).toEqual([snapshot.id]);

    const detail = await app.app.inject({
      method: 'GET',
      url: `/api/v1/universe/snapshots/${snapshot.id}`,
      cookies: { qp_session: cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().snapshot).toMatchObject({ id: snapshot.id, selectedCount: 1 });

    const missing = await app.app.inject({
      method: 'GET',
      url: '/api/v1/universe/snapshots/usn_missing',
      cookies: { qp_session: cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('미인증 요청은 전부 401 이다', async () => {
    const { app } = await setupUniverse();

    for (const [method, url] of [
      ['GET', '/api/v1/universe/historical/status'],
      ['POST', '/api/v1/universe/historical/preview'],
      ['POST', '/api/v1/universe/snapshots'],
      ['GET', '/api/v1/universe/snapshots'],
      ['GET', '/api/v1/universe/snapshots/usn_x'],
    ] as const) {
      const res = await app.app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
