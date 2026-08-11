import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import {
  dailySelectionMetrics,
  krxDailyBars,
  symbolFactsState,
  symbolMasterCoverage,
  symbolMasterMarketCaps,
  symbolMasterTradingDays,
  symbolMasterVersions,
  symbols as symbolsTable,
} from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars, yearRange } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { startKrxFakeServer, type KrxFakeServer } from '../helpers/krx-fixtures.js';

// 이 파일 대부분은 period 가 하루짜리다 — rebalanceInterval 은 그 하루를 리밸런스
// 날짜로 잡는 데만 쓰이고 실제 간격은 의미가 없다. 기본값을 DAY 로 둬 그런 호출이
// rebalanceIntervalFitsPeriod(리뷰 finding, 2026-08-09)에 걸리지 않게 한다 — 여러
// 리밸런스가 실제로 필요한 호출만 MONTH 등으로 명시한다.
const marketCapRule = (
  markets: readonly string[] = ['KOSPI'],
  rebalanceInterval: { unit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'; value: number } = { unit: 'DAY', value: 1 },
) => ({
  markets,
  stages: [{ criterion: 'MARKET_CAP', limit: 10 }],
  rebalanceInterval,
});

async function waitForPreparation(ctx: TestApp, jobId: string): Promise<'COMPLETED' | 'FAILED' | 'CANCELLED'> {
  const started = Date.now();
  for (;;) {
    const status = ctx.container.backtestPreparationOrchestrator.get(jobId)?.status;
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') return status;
    if (Date.now() - started > 2_000) throw new Error('preparation timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function installPreparedPreviewFixture(ctx: TestApp): void {
  // 이 파일은 preview 내용·자동 등록만 격리해 본다. 실전 registry의 DART 요구와
  // 실제 coverage gate는 backtest-preparation.test.ts가 별도로 검증한다.
  const noActionWork: typeof ctx.container.factSyncService.planCorporateActionSync = () => ({
    yearsBySymbol: new Map(),
    shareYearsBySymbol: new Map(),
    todayKstDate: '2026-01-01',
    calls: 0,
    estimatedMs: 0,
    overDailyLimit: false,
  });
  ctx.container.factSyncService.planCorporateActionSync = noActionWork;
  const noActionSync: typeof ctx.container.factSyncService.syncCorporateActions = async () => ({
    savedFacts: 0,
    gaps: [],
    stoppedAtSymbol: null,
    stopReason: null,
    failureMessage: null,
  });
  ctx.container.factSyncService.syncCorporateActions = noActionSync;
  const noMarketSync: typeof ctx.container.symbolMasterService.ingestDate = async () => ({
    kind: 'ALREADY_COVERED',
  });
  ctx.container.symbolMasterService.ingestDate = noMarketSync;
  const rawInject = ctx.app.inject.bind(ctx.app);
  ctx.app.inject = (async (options: unknown) => {
    const request = options as { method?: string; url?: string; payload?: Record<string, unknown> };
    if (request.method === 'POST' && request.url === '/api/v1/backtests/universe-preview') {
      const enriched = {
        ...request,
        payload: {
          ...request.payload,
          strategyId: request.payload?.strategyId ?? 'range-breakout',
          parameters: request.payload?.parameters ?? {},
        },
      };
      const first = await rawInject(enriched as never);
      if (first.statusCode !== 202) return first;
      const jobId = (first.json() as { job: { id: string } }).job.id;
      if (await waitForPreparation(ctx, jobId) !== 'COMPLETED') return first;
      return rawInject(enriched as never);
    }
    return rawInject(options as never);
  }) as typeof ctx.app.inject;
}

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

    // 이 파일은 staged preview 내용·자동 등록 회귀를 검증한다. Task 6부터 첫 호출은
    // durable job(202)을 만들므로 fixture가 그 전제만 완료한 뒤 같은 hash를 재조회한다.
    installPreparedPreviewFixture(ctx);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('단계 파이프라인이 준비되면 pin된 member와 날짜별 단계 진단을 반환한다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    ]);
    ctx.container.database.db.insert(dailySelectionMetrics).values({
      date: '2026-01-05',
      standardCode: 'KR7005930003',
      marketCapKrw: '500000000000000',
      volume: 1_000,
      tradingValueKrw: '1000000000',
    }).onConflictDoUpdate({
      target: [dailySelectionMetrics.date, dailySelectionMetrics.standardCode],
      set: { marketCapKrw: '500000000000000', volume: 1_000, tradingValueKrw: '1000000000' },
    }).run();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: {
          markets: ['KOSPI'],
          stages: [{ criterion: 'MARKET_CAP', limit: 10 }],
          // 이 test는 하루짜리 period 하나만 본다 — 리밸런스 간격 자체는 무관하다.
          rebalanceInterval: { unit: 'DAY', value: 1 },
        },
        period: { from: '2026-01-05', to: '2026-01-05' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      schedule: [{
        rebalanceDate: '2026-01-05',
        effectiveDate: '2026-01-05',
        fromTsMs: Date.parse('2026-01-05T00:00:00Z'),
        members: [{
          symbol: '005930',
          standardCode: 'KR7005930003',
          marketCapKrw: '500000000000000',
          volume: 1_000,
          tradingValueKrw: '1000000000',
        }],
      }],
      diagnostics: [{
        rebalanceDate: '2026-01-05',
        effectiveDate: '2026-01-05',
        stages: [{
          criterion: 'MARKET_CAP',
          inputCount: 1,
          eligibleCount: 1,
          selectedCount: 1,
          excludedMissingCount: 0,
        }],
      }],
      stages: [{ criterion: 'MARKET_CAP', limit: 10 }],
    });
  });

  it('PER 후보 재무가 필요하고 DART key가 없으면 그 요청만 503이다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    ]);
    ctx.container.database.db.insert(dailySelectionMetrics).values({
      date: '2026-01-05',
      standardCode: 'KR7005930003',
      marketCapKrw: '500000000000000',
      volume: 1_000,
      tradingValueKrw: '1000000000',
    }).onConflictDoUpdate({
      target: [dailySelectionMetrics.date, dailySelectionMetrics.standardCode],
      set: { marketCapKrw: '500000000000000', volume: 1_000, tradingValueKrw: '1000000000' },
    }).run();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: {
          markets: ['KOSPI'],
          stages: [{ criterion: 'PER', limit: 10 }],
          // 이 test는 하루짜리 period 하나만 본다 — 리밸런스 간격 자체는 무관하다.
          rebalanceInterval: { unit: 'DAY', value: 1 },
        },
        period: { from: '2026-01-05', to: '2026-01-05' },
      },
    });

    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toContain('DART');
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
        universeRule: marketCapRule(),
        period: { from: '2026-01-05', to: '2026-01-05' },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      schedule: Array<{
        rebalanceDate: string;
        effectiveDate: string;
        fromTsMs: number;
        members: Array<{ symbol: string }>;
      }>;
      unionSymbols: string[];
      scheduleHash: string;
      uncoveredDates: string[];
      periodCovered: boolean;
      missingCandleSymbols: string[];
    };
    expect(body.schedule).toMatchObject([{
      rebalanceDate: '2026-01-05',
      effectiveDate: '2026-01-05',
      fromTsMs: Date.parse('2026-01-05T00:00:00Z'),
      members: [{ symbol: '005930' }],
    }]);
    expect(body.unionSymbols).toEqual(['005930']);
    expect(typeof body.scheduleHash).toBe('string');
    expect(body.scheduleHash.length).toBeGreaterThan(0);
    expect(body.uncoveredDates).toEqual([]);
    // seedSymbolMasterUniverse 는 넓은 고정 구간([2000-01-01, 2099-12-31])으로 커버한다
    expect(body.periodCovered).toBe(true);
    // 봉이 있는 종목이라 missingCandleSymbols 는 비어 있어야 한다
    expect(body.missingCandleSymbols).toEqual([]);
  });

  it('종목 마스터가 커버하지 않는 날짜는 durable preparation job을 시작한다', async () => {
    // 마스터를 전혀 채우지 않는다 — 어떤 날짜도 커버되지 않는다
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: marketCapRule(),
        period: { from: '2026-01-05', to: '2026-01-05' },
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ job: { status: 'QUEUED' } });
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
    ctx.container.database.db.insert(symbolMasterVersions).values({
      ...entry,
      validFromDate: rebalanceDates[0]!,
      validToDate: null,
      recordedAtMs: ctx.container.clock.now(),
    }).run();
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
      ctx.container.database.db.insert(dailySelectionMetrics).values({
        date,
        standardCode: entry.standardCode,
        marketCapKrw: '500000000000000',
        volume: null,
        tradingValueKrw: null,
      }).run();
    }

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        // 이 test는 3개의 월간 리밸런스 날짜가 실제로 필요하다 — 기본값(DAY)이 아니라
        // 명시적으로 MONTH 를 쓴다.
        universeRule: marketCapRule(['KOSPI'], { unit: 'MONTH', value: 1 }),
        period: { from: '2026-01-05', to: '2026-03-05' },
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
        universeRule: marketCapRule(),
        period: { from: '2026-01-05', to: '2026-01-05' },
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
        universeRule: marketCapRule(['KOSPI', 'KOSDAQ']),
        period: { from: '2026-01-05', to: '2026-01-05' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rule의 shared interval로 단일 리밸런스 일정을 만든다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    ]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: marketCapRule(),
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
        universeRule: marketCapRule(),
        period: { from: '2026-01-10', to: '2026-01-05' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('리밸런싱 주기가 기간을 넘으면 400 이다 (backtest-request.ts superRefine과 같은 검사)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: {
          markets: ['KOSPI'],
          stages: [{ criterion: 'MARKET_CAP', limit: 10 }],
          rebalanceInterval: { unit: 'MONTH', value: 2 },
        },
        period: { from: '2026-01-05', to: '2026-01-06' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('리밸런싱 주기가 백테스트 전체 기간을 초과합니다');
  });

  it('존재하지 않는 날짜(2026-13-45)는 500 이 아니라 400 이다', async () => {
    // 정규식만으로는 자릿수만 보고 통과시킨다 — 그러면 준비 파이프라인이 리밸런스
    // 날짜를 계산할 때 RangeError 를 던져 500 이 된다(리뷰 finding, 2026-08-09).
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: marketCapRule(),
        period: { from: '2026-13-45', to: '2026-12-31' },
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
    installPreparedPreviewFixture(ctx);
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
        universeRule: marketCapRule(),
        period: { from: '2026-01-05', to: '2026-01-05' },
      },
    });
    expect(res.statusCode).toBe(200);

    // KOSDAQ(카카오)은 markets:['KOSPI'] 규칙에 안 걸려 unionSymbols 밖이다 — 등록되지 않는다.
    expect(ctx.container.symbolService.exists('035720')).toBe(false);

    const registered = ctx.container.symbolService.getSymbol('005930');
    expect(registered).toMatchObject({ code: '005930', market: 'KR', name: '삼성전자' });
    expect(readStandardCode('005930')).toBe('KR7005930003');
  });

  it('VOLUME-first READY는 staged member만 해당 master entry로 등록한다', async () => {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7000001001', shortCode: '000001', name: '시총상위', market: 'KOSPI', marketCapKrw: '500000000000000' },
      { standardCode: 'KR7000002002', shortCode: '000002', name: '거래량상위', market: 'KOSPI', marketCapKrw: '20000000000000' },
    ]);
    ctx.container.database.db.update(dailySelectionMetrics)
      .set({ volume: 100, tradingValueKrw: '1000000' })
      .where(eq(dailySelectionMetrics.standardCode, 'KR7000001001')).run();
    ctx.container.database.db.update(dailySelectionMetrics)
      .set({ volume: 10_000, tradingValueKrw: '2000000' })
      .where(eq(dailySelectionMetrics.standardCode, 'KR7000002002')).run();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: {
          markets: ['KOSPI'],
          stages: [{ criterion: 'VOLUME', limit: 1 }],
          // 이 test는 하루짜리 period 하나만 본다 — 리밸런스 간격 자체는 무관하다.
          rebalanceInterval: { unit: 'DAY', value: 1 },
        },
        period: { from: '2026-01-05', to: '2026-01-05' },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      schedule: Array<{ members: Array<{ symbol: string; standardCode: string }> }>;
      unionSymbols: string[];
    };
    expect(body.schedule[0]?.members).toMatchObject([
      { symbol: '000002', standardCode: 'KR7000002002' },
    ]);
    expect(body.unionSymbols).toEqual(['000002']);
    expect(ctx.container.symbolService.exists('000001')).toBe(false);
    expect(ctx.container.symbolService.getSymbol('000002')).toMatchObject({
      code: '000002', market: 'KR', name: '거래량상위',
    });
    expect(readStandardCode('000002')).toBe('KR7000002002');
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
          universeRule: marketCapRule(),
          period: { from: '2026-01-05', to: '2026-01-05' },
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
        universeRule: marketCapRule(),
        period: { from: '2026-01-05', to: '2026-01-05' },
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

/** staged READY 뒤에는 legacy 시총 resolver를 다시 실행하지 않는다. */
describe('POST /backtests/universe-preview — staged READY 재조회 방지', () => {
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
    installPreparedPreviewFixture(ctx);
  });

  afterEach(async () => {
    await ctx.close();
    await fake.close();
  });

  it('선정 지표가 준비됐으면 legacy 시총 캐시가 비어 있어도 KRX를 부르지 않고 200이다', async () => {
    const date = '2026-01-05';
    const basDd = date.replaceAll('-', '');

    // 리밸런스 날짜와 staged 선정 지표는 준비하되 legacy 시총 캐시는 비워 둔다.
    // 옛 preview는 READY 뒤 resolve()를 한 번 더 호출해 아래 fake 429를 그대로 받았다.
    ctx.container.database.db.insert(symbolMasterVersions).values({
      standardCode: 'KR7005930003',
      validFromDate: date,
      validToDate: null,
      shortCode: '005930',
      name: '삼성전자',
      market: 'KOSPI',
      sharesOutstanding: '1000000',
      instrumentType: 'COMMON_STOCK',
      listedDate: null,
      recordedAtMs: ctx.container.clock.now(),
    }).run();
    ctx.container.database.db
      .insert(symbolMasterCoverage)
      .values({ startDate: date, endDate: date, syncedAtMs: ctx.container.clock.now() })
      .run();
    // staged resolver가 effective date를 해소할 수 있도록 이 날짜를 거래일로 기록한다.
    ctx.container.database.db.insert(symbolMasterTradingDays).values({ date }).run();
    ctx.container.database.db.insert(dailySelectionMetrics).values({
      date,
      standardCode: 'KR7005930003',
      marketCapKrw: '500000000000000',
      volume: 1_000,
      tradingValueKrw: '1000000000',
    }).run();

    fake.setResponse('stk_bydd_trd', basDd, { status: 429, body: { error: 'quota exceeded' } });
    fake.setResponse('ksq_bydd_trd', basDd, { status: 429, body: { error: 'quota exceeded' } });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: marketCapRule(),
        period: { from: date, to: date },
      },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { unionSymbols: string[] }).unionSymbols).toEqual(['005930']);
    expect(fake.requests).toEqual([]);
  });
});

/**
 * SymbolMasterNotCoveredError → 409 매핑 (리뷰 finding) — 원래는 휴장일만 고립되어
 * 수집된 날짜에서 재현됐다. coverage 는 생기지만 같은 연속 구간 안에 거래일 anchor가
 * 없어 유니버스를 확정할 수 없는 상태다.
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
    ctx = await createTestApp({
      KRX_BASE_URL: fake.baseUrl,
      KRX_API_KEY: 'test-krx-key',
      // 이 describe는 master anchor 해소 경로가 대상이다. 후보 scope가
      // 미상인 range-breakout의 정상 DART gate가 그 경로를 가리지 않게 한다.
      DART_API_KEY: 'test-dart-key',
    });
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

  it('휴장일만 수집돼 거래일 anchor가 없으면 durable preparation job을 시작한다', async () => {
    const date = '2026-01-05';
    // KOSPI·KOSDAQ 양쪽 다 fake 서버 기본값(빈 응답)이라 ingestDate 는 이 날짜를
    // 휴장으로 처리한다 — coverage 는 생기지만 거래일 기록은 생기지 않는다.
    await ctx.container.symbolMasterService.ingestDate(date);
    expect(ctx.container.symbolMasterService.isCovered(date)).toBe(true);
    expect(ctx.container.symbolMasterService.effectiveTradingDate(date)).toBeUndefined();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: marketCapRule(),
        period: { from: date, to: date },
        strategyId: 'range-breakout',
        parameters: {},
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ job: { status: 'QUEUED' } });
  });
});

/**
 * Task 12 — 3단계(시가총액→PER→급하락) 파이프라인의 단계별 진단(N·missing 제외 수·
 * effective date)을 preview 응답만으로 확인한다. DART·자본변동은 이 test의 관심사가
 * 아니므로 직접 seed해 durable job을 거치더라도(`installPreparedPreviewFixture`가
 * 그 202→완료→재조회를 자동으로 처리한다) 실제 sync 호출 없이 곧바로 해소되게 한다.
 */
describe('POST /backtests/universe-preview — 3단계 파이프라인 진단 (Task 12)', () => {
  let ctx: TestApp;
  let cookie: string;
  const EFFECTIVE_DATE = '2025-06-02';
  const CANDLE_START_MS = Date.parse('2025-05-01T00:00:00Z');

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
    installPreparedPreviewFixture(ctx);

    registerSymbols(ctx.container, 'KR', ['X', 'Y', 'Z']);
    seedSymbolMasterUniverse(ctx.container, [EFFECTIVE_DATE], [
      { standardCode: 'KR7000101000', shortCode: 'X', name: 'X', market: 'KOSPI', marketCapKrw: '300' },
      { standardCode: 'KR7000102000', shortCode: 'Y', name: 'Y', market: 'KOSPI', marketCapKrw: '200' },
      { standardCode: 'KR7000103000', shortCode: 'Z', name: 'Z', market: 'KOSPI', marketCapKrw: '100' },
    ]);

    // 급하락(5일) stage 조회 하한(effectiveDate - 5*2-14 = 24일) 보다 이르게 캔들을 채운다.
    // X는 마지막 5일 사이 1000→500으로 급락, Y는 평탄해 X만 급하락 상위로 뽑힌다.
    const candles = [];
    for (let ts = CANDLE_START_MS; ts <= Date.parse(`${EFFECTIVE_DATE}T00:00:00Z`); ts += 86_400_000) {
      const daysFromEffective = Math.round((Date.parse(`${EFFECTIVE_DATE}T00:00:00Z`) - ts) / 86_400_000);
      const xClose = daysFromEffective >= 4 ? 1_000 : 1_000 - (4 - daysFromEffective) * 100;
      candles.push(
        { symbol: 'X', market: 'KR' as const, timeframe: '1d' as const, tsMs: ts, open: xClose, high: xClose, low: xClose, close: xClose, volume: 1_000 },
        { symbol: 'Y', market: 'KR' as const, timeframe: '1d' as const, tsMs: ts, open: 1_000, high: 1_000, low: 1_000, close: 1_000, volume: 1_000 },
      );
    }
    seedDailyBars(ctx.container.database.db, candles);
    await seedCorporateActionCoverage(ctx.container, ['X', 'Y'], yearRange(2024, 2025));

    // PER stage: X·Y는 순이익이 있어 통과하고, Z는 재무가 전혀 없어 missing 제외된다.
    // coverage는 세 종목 모두 "시도했다" 로 직접 심어 DART 호출 없이 즉시 해소되게 한다.
    for (const code of ['X', 'Y', 'Z']) {
      // X·Y는 위 seedCorporateActionCoverage가 이미 symbol_facts_state 행을 만들어 뒀다
      // (actionCoveredYearsJson만 채운 채) — 같은 행에 재무 coveredYearsJson만 덧붙인다.
      ctx.container.database.db
        .insert(symbolFactsState)
        .values({ code, coveredYearsJson: JSON.stringify([2024, 2025]), updatedAtMs: ctx.container.clock.now() })
        .onConflictDoUpdate({
          target: symbolFactsState.code,
          set: { coveredYearsJson: JSON.stringify([2024, 2025]), updatedAtMs: ctx.container.clock.now() },
        })
        .run();
    }
    // Z 는 "시도했지만 공시 0건" 상태다 — 시도의 실체(빈 파티션)가 있어야 coverage
    // 정합성 게이트(parquet-consistent-coverage.ts)가 위 coverage 를 인정한다.
    await ctx.container.factRepository.ensurePartition('SYMBOL', 'Z');
    const netIncomeFacts: Fact[] = ['X', 'Y'].flatMap((symbol) =>
      [40, 30, 20, 10].map((value, offset) => ({
        scope: 'SYMBOL' as const,
        key: symbol,
        field: 'NET_INCOME' as const,
        periodKey: `2024Q${4 - offset}`,
        asOfTsMs: Date.parse('2024-01-01T00:00:00Z'),
        value,
        unit: 'KRW',
      })),
    );
    await ctx.container.factRepository.saveFacts(netIncomeFacts);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('시가총액→PER→급하락 단계별로 N·missing 제외 수·effective date를 정확히 보고한다', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: {
          markets: ['KOSPI'],
          stages: [
            { criterion: 'MARKET_CAP', limit: 3 },
            { criterion: 'PER', limit: 2 },
            { criterion: 'DECLINE', limit: 1, lookbackTradingDays: 5 },
          ],
          // 이 test는 하루짜리 period 하나만 본다 — 리밸런스 간격 자체는 무관하다.
          rebalanceInterval: { unit: 'DAY', value: 1 },
        },
        period: { from: EFFECTIVE_DATE, to: EFFECTIVE_DATE },
        strategyId: 'range-breakout',
        parameters: {},
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      schedule: Array<{ rebalanceDate: string; effectiveDate: string; members: Array<{ symbol: string }> }>;
      diagnostics: Array<{
        rebalanceDate: string;
        effectiveDate: string;
        stages: Array<{
          criterion: string;
          inputCount: number;
          eligibleCount: number;
          selectedCount: number;
          excludedMissingCount: number;
        }>;
      }>;
    };
    expect(body.schedule).toMatchObject([
      { rebalanceDate: EFFECTIVE_DATE, effectiveDate: EFFECTIVE_DATE, members: [{ symbol: 'X' }] },
    ]);
    expect(body.diagnostics).toHaveLength(1);
    expect(body.diagnostics[0]).toMatchObject({
      rebalanceDate: EFFECTIVE_DATE,
      effectiveDate: EFFECTIVE_DATE,
      stages: [
        { criterion: 'MARKET_CAP', inputCount: 3, eligibleCount: 3, selectedCount: 3, excludedMissingCount: 0 },
        { criterion: 'PER', inputCount: 3, eligibleCount: 2, selectedCount: 2, excludedMissingCount: 1 },
        { criterion: 'DECLINE', inputCount: 2, eligibleCount: 2, selectedCount: 1, excludedMissingCount: 0 },
      ],
    });
  });
});
