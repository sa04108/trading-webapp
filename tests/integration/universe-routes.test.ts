import { afterEach, describe, expect, it } from 'vitest';
import {
  symbols,
  universeSnapshots,
  universeSnapshotSymbols,
} from '../../src/server/shared/db/schema.js';
import { addCalendarDays, kstDateOf, kstHourOf } from '../../src/server/modules/market-data/domain/kst-date.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const isoToBasDd = (iso: string): string => iso.replaceAll('-', '');

/**
 * `HistoricalUniverseService.publishedThrough()` 를 그대로 복제한다 — 테스트가
 * 시스템 clock(고정되지 않음)을 그대로 쓰므로 `currentStandardCodeMap` 이 맨 처음
 * 조회하는 날짜를 실행 시점에 계산해야 한다.
 */
function currentListingBaseDate(): string {
  const nowMs = Date.now();
  const yesterday = addCalendarDays(kstDateOf(nowMs), -1);
  return kstHourOf(nowMs) < 8 ? addCalendarDays(yesterday, -1) : yesterday;
}

/**
 * 현시점(스냅샷 기준일과 무관한 「오늘」) 기본정보 — `currentShortCodes` 가 판정에
 * 쓰는 상장 목록이다. KOSPI 는 005930 만, KOSDAQ 은 035720 과 무관한 다른 코드
 * 한 건을 심는다 — 두 시장 다 비어 있지 않아야 탐색이 이 날짜에서 멈춘다
 * (하나라도 비면 최대 31일 전까지 계속 뒤로 넘어간다).
 */
function seedCurrentListing(fake: KrxFakeServer): void {
  const basDd = isoToBasDd(currentListingBaseDate());
  fake.setResponse('stk_isu_base_info', basDd, {
    body: krxEnvelope([baseInfoFixture({ ISU_CD: 'KR7005930003', ISU_SRT_CD: '005930' })]),
  });
  fake.setResponse('ksq_isu_base_info', basDd, {
    body: krxEnvelope([
      baseInfoFixture({
        ISU_CD: 'KR7999999007',
        ISU_SRT_CD: '999999',
        ISU_NM: '더미종목',
        MKT_TP_NM: 'KOSDAQ',
      }),
    ]),
  });
}

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

  it('KOSDAQ 일별 응답이 비어 있으면(전체 후보군 구성 불가) 500이 아니라 502 다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    const basDd = isoToBasDd('2025-01-08');
    // KOSPI 일별은 있어 거래일 자체는 해소되지만, KOSDAQ 일별은 비어 있다 —
    // ksq_bydd_trd 를 설정하지 않으면 fake 서버가 기본값(빈 OutBlock_1)을 돌려준다.
    fake.setResponse('stk_bydd_trd', basDd, {
      body: krxEnvelope([dailyFixture({ ISU_CD: '005930', MKTCAP: '350,000,000,000,000' })]),
    });

    const res = await app.app.inject({
      method: 'POST',
      url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie },
      payload: { date: '2025-01-08' },
    });

    expect(res.statusCode).toBe(502);
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

  it('sortBy 를 생략하면 MKTCAP 이고 응답에 정렬 메타가 실린다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    seedTradingDay(fake, '2025-01-06');
    const res = await app.app.inject({
      method: 'POST', url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie }, payload: { date: '2025-01-06' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sortBy: 'MKTCAP', unknownSortValueCount: 0 });
    expect(res.json().candidates[0].sortValue).toBe(res.json().candidates[0].marketCapKrw);
  });

  it('sortBy=OPERATING_INCOME 은 TTM 영업이익 순으로 rank 를 낸다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    seedTradingDay(fake, '2025-01-06'); // 005930(시총 350조), 035720(시총 20조)
    const asOf = Date.parse('2024-06-01T00:00:00Z');
    const oi = (key: string, periodKey: string, value: number) =>
      ({ scope: 'SYMBOL' as const, key, field: 'OPERATING_INCOME', periodKey, asOfTsMs: asOf, value, unit: 'KRW' });
    // 카카오만 4분기 채운다 — 삼성전자는 값 없음 → 뒤로 밀린다
    await app.container.factRepository.saveFacts([
      oi('035720', '2023Q2', 100), oi('035720', '2023Q3', 100),
      oi('035720', '2023Q4', 100), oi('035720', '2024Q1', 100),
    ]);
    const res = await app.app.inject({
      method: 'POST', url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie }, payload: { date: '2025-01-06', sortBy: 'OPERATING_INCOME' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sortBy).toBe('OPERATING_INCOME');
    expect(body.candidates[0]).toMatchObject({ shortCode: '035720', rank: 1, sortValue: '400' });
    expect(body.candidates[1]).toMatchObject({ shortCode: '005930', rank: null, sortValue: null });
    expect(body.unknownSortValueCount).toBe(1);
  });

  it('허용되지 않는 sortBy 는 400 이다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    seedTradingDay(fake, '2025-01-06');
    const res = await app.app.inject({
      method: 'POST', url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie }, payload: { date: '2025-01-06', sortBy: 'PER' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('스냅샷이 만든 데이터셋은 목록에 기준 시점·정렬 기준·미상장 종목이 실린다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    seedTradingDay(fake, '2025-01-06');
    // 현재(publishedThrough 시점) 기본정보에는 005930 만 있다 → 035720 은 미상장 판정
    seedCurrentListing(fake);

    const preview = await app.app.inject({
      method: 'POST', url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie }, payload: { date: '2025-01-06' },
    });
    const { previewId, candidates } = preview.json();
    await app.app.inject({
      method: 'POST', url: '/api/v1/universe/snapshots',
      cookies: { qp_session: cookie },
      payload: {
        previewId,
        standardCodes: candidates.map((c: { standardCode: string }) => c.standardCode),
        selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
      },
    });

    const res = await app.app.inject({
      method: 'GET', url: '/api/v1/datasets', cookies: { qp_session: cookie },
    });
    const dataset = res.json().datasets[0];
    expect(dataset.universeSnapshot).toMatchObject({ effectiveTradingDate: '2025-01-06', sortKey: 'MKTCAP' });
    expect(dataset.unlistedSymbols).toEqual(['035720']);
  });

  it('현재 목록 조회가 실패하면 unlistedSymbols 는 null 이고 응답은 200 이다', async () => {
    const { app, fake, cookie } = await setupUniverse();
    seedTradingDay(fake, '2025-01-06');
    // 위와 같은 흐름이되 현재 날짜 기본정보를 심지 않아 currentShortCodes 가 실패한다
    // (31일 탐색 실패 → HistoricalUniverseDateError). 응답은 그래도 200.

    const preview = await app.app.inject({
      method: 'POST', url: '/api/v1/universe/historical/preview',
      cookies: { qp_session: cookie }, payload: { date: '2025-01-06' },
    });
    const { previewId, candidates } = preview.json();
    await app.app.inject({
      method: 'POST', url: '/api/v1/universe/snapshots',
      cookies: { qp_session: cookie },
      payload: {
        previewId,
        standardCodes: candidates.map((c: { standardCode: string }) => c.standardCode),
        selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
      },
    });

    const res = await app.app.inject({ method: 'GET', url: '/api/v1/datasets', cookies: { qp_session: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().datasets[0].unlistedSymbols).toBeNull();
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
