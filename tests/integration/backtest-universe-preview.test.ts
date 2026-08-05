import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { symbolMasterCoverage } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { startKrxFakeServer, type KrxFakeServer } from '../helpers/krx-fixtures.js';

/**
 * `POST /backtests/universe-preview` (Task 2, 스펙 2026-08-05) — 위저드가 제출 전에
 * 유니버스 규칙이 실제로 어떤 종목을 고르는지 미리 보는 라우트. `validateSubmission`
 * 과 같은 `UniverseRuleResolver` 를 쓰므로 응답 모양만 검증하고, 해소 로직 자체는
 * `tests/unit/universe-rule-resolver.test.ts` 가 이미 촘촘히 덮는다.
 */
describe('POST /backtests/universe-preview', () => {
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

  it('정상 요청은 schedule·unionSymbols·scheduleHash·missingCandleSymbols 를 담아 200 이다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    ]);
    registerSymbols(ctx.container, 'KR', ['005930']);
    await ctx.container.candleRepository.saveCandles([
      {
        symbol: '005930',
        market: 'KR',
        timeframe: '1d',
        tsMs: Date.UTC(2026, 0, 5),
        open: 1_000,
        high: 1_000,
        low: 1_000,
        close: 1_000,
        volume: 1_000,
      },
    ]);
    await ctx.container.symbolService.refreshCoverage('005930', 'KR', '1d');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: { markets: ['KOSPI'], topN: 10, sortKey: 'MKTCAP' },
        period: { from: '2026-01-05', to: '2026-01-05' },
        rebalanceMonths: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      schedule: Array<{ rebalanceDate: string; symbols: string[] }>;
      unionSymbols: string[];
      scheduleHash: string;
      uncoveredDates: string[];
      missingCandleSymbols: string[];
    };
    expect(body.schedule).toEqual([{ rebalanceDate: '2026-01-05', symbols: ['005930'] }]);
    expect(body.unionSymbols).toEqual(['005930']);
    expect(typeof body.scheduleHash).toBe('string');
    expect(body.scheduleHash.length).toBeGreaterThan(0);
    expect(body.uncoveredDates).toEqual([]);
    // 봉이 있는 종목이라 missingCandleSymbols 는 비어 있어야 한다
    expect(body.missingCandleSymbols).toEqual([]);
  });

  it('종목 마스터가 커버하지 않는 날짜는 uncoveredDates 에 담아 응답한다 (200, 차단 아님)', async () => {
    // 마스터를 전혀 채우지 않는다 — 어떤 날짜도 커버되지 않는다
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: { markets: ['KOSPI'], topN: 10, sortKey: 'MKTCAP' },
        period: { from: '2026-01-05', to: '2026-01-05' },
        rebalanceMonths: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { uncoveredDates: string[]; schedule: unknown[]; unionSymbols: string[] };
    expect(body.uncoveredDates).toEqual(['2026-01-05']);
    expect(body.schedule).toEqual([]);
    expect(body.unionSymbols).toEqual([]);
  });

  it('종목 마스터에는 있지만 캔들이 없는 종목을 missingCandleSymbols 로 밝힌다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    ]);
    // 로컬 종목 등록도, 봉도 없다 — 위저드가 「가격 데이터 탭에서 동기화하세요」 를 안내할 근거

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: { markets: ['KOSPI'], topN: 10, sortKey: 'MKTCAP' },
        period: { from: '2026-01-05', to: '2026-01-05' },
        rebalanceMonths: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { missingCandleSymbols: string[] };
    expect(body.missingCandleSymbols).toEqual(['005930']);
  });

  it('markets 가 2개면 스키마 위반으로 400 이다', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: { markets: ['KOSPI', 'KOSDAQ'], topN: 10, sortKey: 'MKTCAP' },
        period: { from: '2026-01-05', to: '2026-01-05' },
        rebalanceMonths: 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rebalanceMonths 미지정은 기본값 1 이다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    ]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: { markets: ['KOSPI'], topN: 10, sortKey: 'MKTCAP' },
        period: { from: '2026-01-05', to: '2026-01-05' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { schedule: unknown[] };
    expect(body.schedule).toHaveLength(1);
  });

  it('기간이 뒤집히면 400 이다', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: { markets: ['KOSPI'], topN: 10, sortKey: 'MKTCAP' },
        period: { from: '2026-01-10', to: '2026-01-05' },
        rebalanceMonths: 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * KRX 오류 매핑 (리뷰 finding) — `UniverseRuleResolver.resolve` 는 시총 캐시 미스일 때
 * `getMarketCapsAt` 을 통해 실제 KRX 를 부른다. `symbol-master-routes.ts` 의
 * `/symbol-master/sync` 와 같은 관례로 KrxQuotaError→429 를 매핑해야 한다 — 매핑이
 * 없으면 쿼터 초과가 일반 500 으로 노출된다. 제출 경로(`validateSubmission`)는 같은
 * `sendIfKrxError` 헬퍼를 타므로 별도 테스트를 생략한다.
 */
describe('POST /backtests/universe-preview — KRX 오류 매핑', () => {
  let ctx: TestApp;
  let fake: KrxFakeServer;
  let cookie: string;

  beforeEach(async () => {
    fake = await startKrxFakeServer();
    ctx = await createTestApp({ KRX_BASE_URL: fake.baseUrl, KRX_API_KEY: 'test-krx-key' });
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
    await fake.close();
  });

  it('KRX 가 429 를 돌려주면 미리보기도 429 로 응답한다 (일반 500 이 아니다)', async () => {
    const date = '2026-01-05';
    const basDd = date.replaceAll('-', '');

    // 리밸런스 날짜는 커버되지만(체크포인트+coverage) 시총 캐시는 비워 둔다 —
    // getMarketCapsAt 이 캐시 미스로 실제 KRX(fake 서버)를 부르게 하기 위해서다.
    ctx.container.symbolMasterService.saveCheckpoint(
      date,
      new Map([
        [
          'KR7005930003',
          {
            standardCode: 'KR7005930003',
            shortCode: '005930',
            name: '삼성전자',
            market: 'KOSPI' as const,
            sharesOutstanding: '1000000',
            instrumentType: 'COMMON_STOCK' as const,
            listedDate: null,
          },
        ],
      ]),
      true,
    );
    ctx.container.database.db
      .insert(symbolMasterCoverage)
      .values({ startDate: date, endDate: date, syncedAtMs: ctx.container.clock.now() })
      .run();

    fake.setResponse('stk_bydd_trd', basDd, { status: 429, body: { error: 'quota exceeded' } });
    fake.setResponse('ksq_bydd_trd', basDd, { status: 429, body: { error: 'quota exceeded' } });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: { markets: ['KOSPI'], topN: 10, sortKey: 'MKTCAP' },
        period: { from: date, to: date },
        rebalanceMonths: 1,
      },
    });

    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: string }).error).toContain('한도');
  });
});
