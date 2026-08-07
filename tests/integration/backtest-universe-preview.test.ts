import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  krxDailyBars,
  symbolMasterCoverage,
  symbolMasterMarketCaps,
  symbolMasterTradingDays,
  symbols as symbolsTable,
} from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols, seedDailyBars } from '../helpers/seed.js';
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
    seedDailyBars(ctx.container.database.db, [
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
      schedule: Array<{ rebalanceDate: string; effectiveTradingDate: string; symbols: string[] }>;
      unionSymbols: string[];
      scheduleHash: string;
      uncoveredDates: string[];
      periodCovered: boolean;
      missingCandleSymbols: string[];
    };
    expect(body.schedule).toEqual([
      { rebalanceDate: '2026-01-05', effectiveTradingDate: '2026-01-05', symbols: ['005930'] },
    ]);
    expect(body.unionSymbols).toEqual(['005930']);
    expect(typeof body.scheduleHash).toBe('string');
    expect(body.scheduleHash.length).toBeGreaterThan(0);
    expect(body.uncoveredDates).toEqual([]);
    // seedSymbolMasterUniverse 는 넓은 고정 구간([2000-01-01, 2099-12-31])으로 커버한다
    expect(body.periodCovered).toBe(true);
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
    const body = res.json() as {
      uncoveredDates: string[];
      periodCovered: boolean;
      schedule: unknown[];
      unionSymbols: string[];
    };
    expect(body.uncoveredDates).toEqual(['2026-01-05']);
    expect(body.periodCovered).toBe(false);
    expect(body.schedule).toEqual([]);
    expect(body.unionSymbols).toEqual([]);
  });

  /**
   * 운영에서 확인된 버그의 정확한 재현 조건 — 리밸런스 날짜(매달 5일) 3개는 모두
   * 개별로 커버해 두되, 그 사이 평일은 전혀 커버하지 않는다. `uncoveredDates` 는
   * 리밸런스 날짜만 보므로 빈 배열이 되어 예전 조건(`uncoveredDates.length > 0`)
   * 이면 "기간 전체 동기화" 버튼이 사라졌다 — 그 상태에서 봉 없는 종목에 남는
   * 유일한 해결책은 증권사 동기화뿐이었고, 상장폐지 종목은 증권사가 모르므로
   * 반드시 404 로 실패했다. `periodCovered` 가 이 틈을 정확히 false 로 보고해야
   * 위저드가 올바른 버튼을 계속 띄울 수 있다.
   */
  it('리밸런스 날짜는 전부 커버돼도 그 사이 기간이 비어 있으면 periodCovered 를 false 로 보고한다', async () => {
    const rebalanceDates = ['2026-01-05', '2026-02-05', '2026-03-05'];
    const entry = {
      standardCode: 'KR7005930003',
      shortCode: '005930',
      name: '삼성전자',
      market: 'KOSPI' as const,
      sharesOutstanding: '1000000',
      instrumentType: 'COMMON_STOCK' as const,
      listedDate: null,
    };
    ctx.container.symbolMasterService.saveCheckpoint(
      rebalanceDates[0]!,
      new Map([[entry.standardCode, entry]]),
      true,
    );
    for (const date of rebalanceDates) {
      // 리밸런스 날짜 하나씩만 하루짜리 coverage 로 개별 동기화된 상태를 그대로
      // 재현한다 — 기간 전체 백필이 아니라 날짜 단위 소급(POST /symbol-master/sync)
      // 이 반복된 결과다.
      ctx.container.database.db
        .insert(symbolMasterCoverage)
        .values({ startDate: date, endDate: date, syncedAtMs: ctx.container.clock.now() })
        .run();
      ctx.container.database.db.insert(symbolMasterTradingDays).values({ date }).run();
      ctx.container.database.db
        .insert(symbolMasterMarketCaps)
        .values({ date, standardCode: entry.standardCode, marketCapKrw: '500000000000000' })
        .run();
    }

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: { markets: ['KOSPI'], topN: 10, sortKey: 'MKTCAP' },
        period: { from: '2026-01-05', to: '2026-03-05' },
        rebalanceMonths: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      uncoveredDates: string[];
      periodCovered: boolean;
      schedule: unknown[];
    };
    // 리밸런스 날짜 3개(1/5, 2/5, 3/5) 는 모두 커버됐다 — 예전 조건이라면 여기서 버튼이 사라졌다.
    expect(body.uncoveredDates).toEqual([]);
    expect(body.schedule).toHaveLength(3);
    // 그 사이(1/6~2/4, 2/6~3/4) 평일은 여전히 비어 있다 — periodCovered 가 이를 잡아야 한다.
    expect(body.periodCovered).toBe(false);
  });

  it('종목 마스터에는 있지만 캔들이 없는 종목을 missingCandleSymbols 로 밝힌다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    ]);
    // 로컬 종목은 미리 등록해 두지 않는다 — 이 미리보기 응답 자체가 unionSymbols 를
    // 자동 등록하므로(Task 4, 아래 describe 참고), 여기서는 등록 여부와 무관하게
    // 봉이 없다는 사실만 검증한다.

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
 * 유니버스 종목 자동 등록(브리프 §5, 스펙 2026-08-06 Task 4) — 미리보기가 만든
 * unionSymbols 를 `symbols` 에 등록한다. 이름·시장·표준코드는 종목 마스터에서
 * 가져온다: 증권사 조회는 상장폐지 종목의 이름을 주지 않아 그 출처로는 등록할 수
 * 없기 때문이다. 등록은 미리보기 응답 시점에 붙인다 — 판단 근거는
 * backtest-routes.ts registerUniverseSymbols 주석 참고.
 */
describe('POST /backtests/universe-preview — 유니버스 종목 자동 등록', () => {
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

  const readStandardCode = (code: string): string | null =>
    ctx.container.database.db
      .select({ standardCode: symbolsTable.standardCode })
      .from(symbolsTable)
      .where(eq(symbolsTable.code, code))
      .get()?.standardCode ?? null;

  it('unionSymbols 를 종목 마스터의 이름·시장·표준코드로 자동 등록한다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
      { standardCode: 'KR7035720002', shortCode: '035720', name: '카카오', market: 'KOSDAQ', marketCapKrw: '20000000000000' },
    ]);
    expect(ctx.container.symbolService.exists('005930')).toBe(false);
    expect(ctx.container.symbolService.exists('035720')).toBe(false);

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

    // KOSDAQ(카카오)은 markets:['KOSPI'] 규칙에 안 걸려 unionSymbols 밖이다 — 등록되지 않는다.
    expect(ctx.container.symbolService.exists('035720')).toBe(false);

    const registered = ctx.container.symbolService.getSymbol('005930');
    expect(registered).toMatchObject({ code: '005930', market: 'KR', name: '삼성전자' });
    expect(readStandardCode('005930')).toBe('KR7005930003');
  });

  it('이미 등록된 종목은 다시 미리보기해도 실패하지 않고 표준코드를 덮어쓰지 않는다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    ]);
    // 사용자가 이미 손으로(또는 이전 실행에서) 등록해 뒀다 — 이름·표준코드 없이.
    ctx.container.symbolService.addSymbol('005930', 'KR');
    expect(readStandardCode('005930')).toBeNull();

    for (let i = 0; i < 2; i += 1) {
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
    }

    // 재등록 시도가 있었어도 기존 값(표준코드 없음)을 덮어쓰지 않는다 —
    // 단축코드 재사용 판별의 유일한 열쇠라 새 조회로 갈아치우면 안 된다.
    expect(readStandardCode('005930')).toBeNull();
    expect(ctx.container.symbolService.getSymbol('005930')?.name).toBeNull();
  });

  /**
   * 회귀(스펙 2026-08-06 Task 5 리뷰 발견) — `addSymbol` 은 `symbolCoverage` 캐시를
   * 채우지 않는다. 그 캐시는 오직 증권사 동기화·CSV 가져오기가 끝난 뒤에만
   * `refreshCoverage` 로 채워지는데, 상장폐지 종목은 둘 중 어느 것도 겪지 않는다
   * (증권사는 상장폐지 종목의 봉을 안 주고, CSV 가져오기는 수동이다). `backfill`
   * 이 이미 `krx_daily_bars` 를 채워 뒀어도 이 갱신이 없으면 `missingCandleSymbols`
   * 와 가격 데이터 탭 모두 "봉 없음" 으로 남아, Task 4 가 적은 "자동 등록하면
   * 가격 데이터 탭에서 상장폐지 종목도 보인다" 는 전제가 깨진다 — 이 테스트는
   * `refreshCoverage` 를 직접 부르지 않고 `krx_daily_bars` 만 미리 심어 둔 채
   * 미리보기 한 번으로 그 전제가 실제로 성립하는지 확인한다.
   */
  it('krx_daily_bars 만 있고 캐시를 갱신한 적 없는 종목도 missingCandleSymbols 에서 빠진다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      {
        standardCode: 'KR7900010009',
        shortCode: '900010',
        name: '상장폐지예정1호',
        market: 'KOSPI',
        marketCapKrw: '500000000000000',
      },
    ]);
    // 백필이 이미 이 종목의 KRX 일봉을 채워 뒀다고 가정한다 — refreshCoverage 는
    // 일부러 부르지 않는다. 이 값 자체를 미리보기가 대신 갱신해야 한다.
    ctx.container.database.db
      .insert(krxDailyBars)
      .values({
        shortCode: '900010',
        date: '2026-01-05',
        market: 'KOSPI',
        open: 1_000,
        high: 1_100,
        low: 900,
        close: 1_050,
        volume: 12_345,
      })
      .run();

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
    const body = res.json() as { unionSymbols: string[]; missingCandleSymbols: string[] };
    expect(body.unionSymbols).toEqual(['900010']);
    expect(body.missingCandleSymbols).toEqual([]);

    // 가격 데이터 탭이 읽는 커버리지도 같은 `krx_daily_bars` 집계다 — 실제로 "봉 있음" 으로 보인다.
    const coverage = ctx.container.candleCoverageService.getCoverage(['900010'])[0]!;
    expect(coverage.barCount).toBe(1);
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
    // resolver 는 이제 effectiveTradingDate(date) 도 게이트로 보므로, 이 날짜를 거래일로도
    // 기록해 둬야 게이트를 통과해 getMarketCapsAt 까지 도달한다.
    ctx.container.database.db.insert(symbolMasterTradingDays).values({ date }).run();

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

/**
 * SymbolMasterNotCoveredError → 409 매핑 (리뷰 finding) — 원래는 휴장일만 수집된
 * 날짜에서 재현됐다. coverage 는 생기지만 체크포인트는 생기지 않는데
 * (`ingestDateUnguarded` 의 HOLIDAY 분기는 `mergeCoverage` 만 부르고 `writeCheckpoint`
 * 는 부르지 않는다), 그 상태에서 `isCovered(date)` 는 true 를 주지만 `getUniverseAsOf`
 * 는 `nearestCheckpoint` 를 하나도 찾지 못해 `SymbolMasterNotCoveredError` 를 던졌다 —
 * 이게 실제 운영에서 500 으로 터진 시나리오다.
 *
 * 리밸런스 적용 거래일 해소(Task 3, 스펙 2026-08-06)를 넣은 뒤로는 resolver 가
 * `isCovered(date)` 와 `effectiveTradingDate(date)` 를 둘 다 게이트로 본다. 휴장만
 * 수집된 날짜는 거래일로 기록되지 않으므로 `effectiveTradingDate` 가 undefined 다 —
 * `getUniverseAsOf` 를 부르기도 전에 uncoveredDates 로 걸러져 200 으로 응답한다.
 * 그래서 아래 테스트는 이제 409 대신 그 우아한 경로(uncoveredDates)를 검증한다.
 * `sendIfNotCovered` 매핑 자체는 이 resolver 경로가 아닌 다른 진입점을 위한 방어로
 * 그대로 남겨 둔다 — 제거 대상이 아니다.
 */
describe('POST /backtests/universe-preview — SymbolMasterNotCoveredError 매핑', () => {
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

  it('휴장일만 수집돼 체크포인트가 없으면 미리보기는 uncoveredDates 로 걸러진다 (더 이상 500 도 409 도 아니다)', async () => {
    const date = '2026-01-05';
    // KOSPI·KOSDAQ 양쪽 다 fake 서버 기본값(빈 응답)이라 ingestDate 는 이 날짜를
    // 휴장으로 처리한다 — coverage 는 생기지만 체크포인트도, 거래일 기록도 생기지 않는다.
    await ctx.container.symbolMasterService.ingestDate(date);
    expect(ctx.container.symbolMasterService.isCovered(date)).toBe(true);
    expect(ctx.container.symbolMasterService.effectiveTradingDate(date)).toBeUndefined();

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

    expect(res.statusCode).toBe(200);
    const body = res.json() as { uncoveredDates: string[]; schedule: unknown[] };
    expect(body.uncoveredDates).toEqual([date]);
    expect(body.schedule).toEqual([]);
  });
});
