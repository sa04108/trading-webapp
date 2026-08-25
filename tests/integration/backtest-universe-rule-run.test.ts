import { createHash } from 'node:crypto';
import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { FactSyncReport, FactSyncRequest } from '../../src/server/modules/facts/application/fact-sync-service.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import {
  krxDailyBars,
  krxNonTradingCoverage,
  krxNonTradingDays,
  symbolFactsState,
  symbolMasterVersions,
} from '../../src/server/shared/db/schema.js';
import {
  getCostProfile,
  getKrxExecutionRules,
  getSlippageProfile,
} from '../../src/server/modules/backtest/domain/cost-profiles.js';
import { simulateFill } from '../../src/server/modules/backtest/domain/execution.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars, yearRange } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

const DAY = 86_400_000;

/**
 * 유니버스 규칙 백테스트 실행 회귀 (D-024).
 * 자식 프로세스가 데이터셋 timeframe 을 무시하고 1h 로 캔들을 읽던 버그 —
 * 일봉 수집 데이터셋(timeframe=1d)은 1h 파티션이 없어 0봉으로 실패했다.
 *
 * 유니버스는 이제 데이터셋이 아니라 유니버스 규칙(스펙 2026-08-05)이 정한다 —
 * 이 파일의 픽스처는 종목 마스터를 직접 채워(`seedSymbolMasterUniverse`) 실제 KRX
 * 호출 없이 `UniverseRuleResolver` 를 태운다. 두 종목(005930 이 항상 1위, 000660 은
 * 2위)을 마스터에 함께 두고, universeRule.topN 으로 몇 종목이 유니버스에 들어올지
 * 테스트별로 조절한다.
 */
function buildDailyCandles(symbol = '005930'): Candle[] {
  const candles: Candle[] = [];
  const end = Date.UTC(2026, 6, 24); // 2026-07-24 (금)
  let cursor = Date.UTC(2025, 6, 28); // 2025-07-28 (월)
  let index = 0;

  while (cursor <= end) {
    const dayOfWeek = new Date(cursor).getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const phase = index % 60;
      const base = phase < 35 ? 60_000 + phase * 400 : 74_000 - (phase - 35) * 500;
      const open = base;
      const close = base + 300;
      candles.push({
        symbol,
        market: 'KR',
        timeframe: '1d',
        tsMs: cursor,
        open,
        high: close + 200,
        low: open - 400,
        close,
        volume: 1_000_000,
      });
      index += 1;
    }
    cursor += DAY;
  }
  return candles;
}

/** 이 파일의 테스트가 리밸런스 날짜로 쓰는 값 전부 — 종목 마스터 시총 캐시를 이 날짜들로 채운다 */
const MASTER_DATES = ['2025-07-27', '2025-08-01', '2025-09-01', '2025-10-01'];

function universeRule(topN: number): BacktestRequest['universeRule'] {
  return {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: topN }],
    rebalanceInterval: { value: 1, unit: 'MONTH' },
  };
}

function buildRequest(topN = 1): BacktestRequest {
  return {
    strategyId: 'range-breakout',
    parameters: {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      riskPerTradePercent: 2,
    },
    universeRule: universeRule(topN),
    period: { from: '2025-07-27', to: '2026-07-24' },
    capital: { initialCash: 10_000_000, currency: 'KRW' },
    execution: {
      fillTiming: 'NEXT_BAR_OPEN',
      commissionProfileId: 'kr-equity-default',
      slippageProfileId: 'fixed-5bps',
    },
    risk: { maxPositions: 5 },
    randomSeed: 42,
  };
}

function singleDayRequest(topN: number, date: string): BacktestRequest {
  const request = buildRequest(topN);
  return {
    ...request,
    universeRule: {
      ...request.universeRule,
      rebalanceInterval: { unit: 'DAY', value: 1 },
    },
    period: { from: date, to: date },
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** 이 파일의 실행/게이트 테스트가 Task 6의 완료된 preparation 전제를 갖추게 한다. */
function installPreparedSubmissionFixture(ctx: TestApp): void {
  // 제출 검증/worker 회귀가 관찰 대상이다. preparation의 실제 DART gate와 coverage
  // 실행은 backtest-preparation.test.ts에서 검증하므로 여기서는 외부 sync만 격리한다.
  const noWorkPlan = {
    yearsBySymbol: new Map(),
    shareYearsBySymbol: new Map(),
    todayKstDate: '2026-01-01',
    calls: 0,
    estimatedMs: 0,
    overDailyLimit: false,
  };
  const planFinancialSync: typeof ctx.container.factSyncService.planFinancialSync = () => noWorkPlan;
  const planCorporateActionSync: typeof ctx.container.factSyncService.planCorporateActionSync = () => noWorkPlan;
  ctx.container.factSyncService.planFinancialSync = planFinancialSync;
  ctx.container.factSyncService.planCorporateActionSync = planCorporateActionSync;
  ctx.container.factSyncService.sync = async (request) => {
    const years = yearRange(request.fromYear, request.toYear);
    for (const symbol of request.symbols) {
      ctx.container.factCoverageStore.addCoveredYears(symbol, years, ctx.container.clock.now());
    }
    return {
      savedFacts: 0,
      gaps: [],
      stoppedAtSymbol: null,
      stopReason: null,
      failureMessage: null,
    };
  };
  ctx.container.factSyncService.syncCorporateActions = async (request) => {
    const years = yearRange(request.fromYear, request.toYear);
    for (const symbol of request.symbols) {
      ctx.container.actionCoverageStore.addCoverageResult(
        symbol,
        years,
        [],
        ctx.container.clock.now(),
      );
    }
    return {
      savedFacts: 0,
      gaps: [],
      stoppedAtSymbol: null,
      stopReason: null,
      failureMessage: null,
    };
  };
  const rawInject = ctx.app.inject.bind(ctx.app);
  ctx.app.inject = (async (options: unknown) => {
    const request = options as { method?: string; url?: string; payload?: BacktestRequest };
    const first = await rawInject(options as never);
    if (
      request.method !== 'POST'
      || request.url !== '/api/v1/backtests'
      || first.statusCode !== 409
      || (first.json() as { error?: string }).error !== 'PREPARATION_REQUIRED'
      || request.payload === undefined
    ) return first;

    const body = request.payload;
    const preparation = ctx.container.backtestPreparationOrchestrator.start({
      universeRule: body.universeRule,
      period: body.period,
      strategyId: body.strategyId,
      parameters: body.parameters,
    });
    await waitFor(() => {
      const status = ctx.container.backtestPreparationOrchestrator.get(preparation.id)?.status;
      return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
    }, 5_000);
    if (ctx.container.backtestPreparationOrchestrator.get(preparation.id)?.status !== 'COMPLETED') {
      return first;
    }
    return rawInject(options as never);
  }) as typeof ctx.app.inject;
}

describe('유니버스 규칙 백테스트 실행 (D-024)', () => {
  let ctx: TestApp;
  let cookie: string;
  let dailyCandles: Candle[];

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
    installPreparedSubmissionFixture(ctx);

    // 증권사 일봉 동기화가 만드는 상태를 그대로 재현한다 (로컬 종목 등록 + 1d 파티션)
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);
    seedSymbolMasterUniverse(ctx.container, MASTER_DATES, [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
      { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSPI', marketCapKrw: '1000000000000' },
    ]);
    dailyCandles = buildDailyCandles();
    seedDailyBars(ctx.container.database.db, dailyCandles);
    // 자본변동 게이트(Task 6) — 이 파일의 제출 기간이 걸치는 연도(2025·2026)를 채운다
    await seedCorporateActionCoverage(ctx.container, ['005930', '000660'], yearRange(2025, 2026));
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('커버리지가 보고한 일봉으로 백테스트가 완주한다', { timeout: 90_000 }, async () => {
    // 사용자가 보는 화면: 커버리지는 봉이 있다고 말한다
    const coverage = ctx.container.candleCoverageService.getCoverage(['005930']);
    expect(coverage[0]!.barCount).toBe(dailyCandles.length);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    const job = ctx.container.jobQueue.getJob(jobId)!;
    // 회귀 지점: 여기서 '선택한 기간·종목에 데이터가 없습니다' 로 실패하던 버그
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');
    // 데이터셋 timeframe(1d) 봉을 전부 읽었는지 — 1h 로 읽으면 0봉이 된다
    expect(job.totalBars).toBe(dailyCandles.length);

    // 알림 설명이 읽는 값 — getMetrics 의 metricsJson 파싱 결과와 같아야 한다
    const metrics = ctx.container.resultsService.getMetrics(jobId) as {
      initialCash: number;
      finalEquity: number;
      totalReturnPct: number;
      cagrPct: number | null;
    };
    expect(ctx.container.resultsService.getTotalReturnPct(jobId)).toBe(metrics.totalReturnPct);
    // 결과가 없는 잡은 null 이다 — 0 으로 떨어지면 "수익 0%" 로 읽힌다
    expect(ctx.container.resultsService.getTotalReturnPct('bt_없는잡')).toBeNull();

    // 요청 시작일은 일요일이라 첫 실제 봉보다 하루 이르다. Worker가 첫 봉부터만
    // CAGR을 재면 기간이 짧아지므로 요청 날짜 anchor와 같은 분모인지 함께 검증한다.
    const full = ctx.container.resultsService.getFullExport(jobId);
    const requestedFromTsMs = Date.parse('2025-07-27T00:00:00Z');
    const requestedToTsMs = Date.parse('2026-07-24T00:00:00Z');
    expect(full.equityPoints[0]?.tsMs).toBe(requestedFromTsMs);
    expect(full.equityPoints.at(-1)?.tsMs).toBe(requestedToTsMs);
    expect(metrics.cagrPct).toBeCloseTo(
      ((metrics.finalEquity / metrics.initialCash) ** (
        365 / ((requestedToTsMs - requestedFromTsMs) / DAY)
      ) - 1) * 100,
    );

    // 배선 전체가 이어졌는지 — 리스너가 레지스트리 이름과 수익률을 함께 담는다.
    // 상태를 기다린 것만으로는 부족하다: 자식이 종료 전에 COMPLETED 를 DB 에 쓰고
    // 알림은 그 뒤 부모의 exit 핸들러에서 뜬다(job-orchestrator).
    const findNotification = () =>
      ctx.container.notificationService.list().find((row) => row.link === `/backtests/${jobId}`);
    await waitFor(() => findNotification() !== undefined, 10_000);

    const notification = findNotification();
    expect(notification?.title).toBe('백테스트가 완료되었습니다');
    expect(notification?.body).toContain('전고점 돌파');
    expect(notification?.body).toContain('수익률');
    // kebab-case 식별자가 새면 안 된다
    expect(notification?.body).not.toContain('range-breakout');
  });

  it('worker가 period 이전 KRX warm-up을 전략에 공급하되 결과는 period 첫 봉부터 기록한다', { timeout: 90_000 }, async () => {
    const request = {
      ...buildRequest(1),
      period: { from: '2025-09-01', to: '2025-10-31' },
    };
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: request,
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');
    const periodFromTsMs = Date.parse('2025-09-01T00:00:00Z');
    const periodToTsMs = Date.parse('2025-10-31T23:59:59.999Z');
    const expectedPeriodBars = dailyCandles.filter(
      (candle) => candle.tsMs >= periodFromTsMs && candle.tsMs <= periodToTsMs,
    ).length;
    const full = ctx.container.resultsService.getFullExport(jobId);

    expect(job.totalBars).toBe(expectedPeriodBars);
    expect(full.equityPoints[0]?.tsMs).toBe(periodFromTsMs);
    expect(full.equityPoints).toHaveLength(expectedPeriodBars);
    // warm-up 마지막 상승 봉의 BUY는 결과 주문으로 만들지 않지만 전략의 pendingEntry
    // state는 갱신된다. Sep 1에 그 상태를 해소하고 Sep 2에 다시 신호를 내므로 실제
    // NEXT_BAR_OPEN 진입은 Sep 3이다. warm-up 자체가 없으면 lookback을 다시 채우느라
    // 이 날짜보다 늦어진다.
    expect(full.trades[0]?.entryTsMs).toBe(Date.parse('2025-09-03T00:00:00Z'));
  });

  it('확정 유니버스 중 기간 내 0봉 종목이 있으면 제출을 거부한다', async () => {
    // topN=2 로 올리면 시총 2위(000660, 봉 없음)도 유니버스에 들어온다 —
    // 그 종목만 제외해 schedule을 바꾸지 않고 제출 전에 중단한다.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(2),
    });
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error: string }).error).toContain('000660');
  });

  it('제출 뒤 선정 종목의 기간 봉이 사라져도 worker가 결과 생성 전에 중단한다', { timeout: 90_000 }, async () => {
    // 7~8월 봉은 worker의 warm-up 구간에 실제로 로드되고, 요청 기간인
    // 9~10월 봉만 삭제한다. worker가 warm-up 봉을 기간 봉으로 잘못 세어도
    // 통과하는 회귀를 막는 픽스처다.
    const request = {
      ...buildRequest(2),
      period: { from: '2025-09-01', to: '2025-10-31' },
    };
    seedDailyBars(ctx.container.database.db, buildDailyCandles('000660'));
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: request,
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    ctx.container.database.db.delete(krxDailyBars)
      .where(and(
        eq(krxDailyBars.shortCode, '000660'),
        gte(krxDailyBars.date, request.period.from),
        lte(krxDailyBars.date, request.period.to),
      ))
      .run();
    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.status).toBe('FAILED');
    expect(job.error).toContain('000660');
    expect(ctx.container.resultsService.getRun(jobId)).toBeNull();
  });

  it('마지막 실행 봉 뒤 공시만 있는 데이터셋에 밸류 전략을 제출하면 422 로 거부한다', async () => {
    await ctx.container.factRepository.saveFacts([{
      scope: 'SYMBOL', key: '005930', field: 'NET_INCOME', periodKey: '2025Q3',
      asOfTsMs: Date.parse('2025-10-31T01:00:00Z'), value: 1, unit: 'KRW',
    }]);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        strategyId: 'value-quality-rank',
        parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
        universeRule: universeRule(1),
        timeframe: '1d',
        period: { from: '2025-08-01', to: '2025-10-31' },
        capital: { initialCash: 10_000_000, currency: 'KRW' },
        execution: {
          fillTiming: 'NEXT_BAR_OPEN',
          commissionProfileId: 'kr-equity-default',
          slippageProfileId: 'fixed-5bps',
        },
        risk: { maxPositions: 20 },
        randomSeed: 42,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('coverage 기록은 있지만');
    expect(response.json().error).toContain('기간 종료일·유니버스·전략');
  });

  it('준비 확인 직후 일부 종목의 필수 연도 coverage가 사라져도 enqueue하지 않는다', async () => {
    seedDailyBars(ctx.container.database.db, buildDailyCandles('000660'));
    await ctx.container.factRepository.saveFacts([{
      scope: 'SYMBOL', key: '005930', field: 'NET_INCOME', periodKey: '2025Q1',
      asOfTsMs: Date.parse('2025-07-31T00:00:00Z'), value: 1, unit: 'KRW',
    }]);
    const payload: BacktestRequest = {
      strategyId: 'value-quality-rank',
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
      universeRule: universeRule(2),
      timeframe: '1d',
      period: { from: '2025-08-01', to: '2025-10-31' },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
      },
      risk: { maxPositions: 1 },
      randomSeed: 41,
    };
    const first = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload,
    });
    expect(first.statusCode).toBe(201);
    const prepared = ctx.container.backtestPreparationOrchestrator.getCachedPreview({
      universeRule: payload.universeRule,
      period: payload.period,
      strategyId: payload.strategyId,
      parameters: payload.parameters,
    });
    expect(prepared).not.toBeNull();

    ctx.container.database.db.update(symbolFactsState)
      .set({ coveredYearsJson: JSON.stringify([2025]) })
      .where(eq(symbolFactsState.code, '000660'))
      .run();
    // getReadyPreview의 현재성 확인과 실제 enqueue 사이 삭제 race를 직접 재현한다.
    ctx.container.backtestPreparationOrchestrator.getReadyPreview = async () => prepared;
    ctx.container.factSyncService.sync = async () => ({
      savedFacts: 0,
      gaps: [],
      stoppedAtSymbol: null,
      stopReason: null,
      failureMessage: null,
    });
    const beforeCount = ctx.container.jobQueue.listJobs(100, 0).length;
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...payload, randomSeed: 42 },
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toBe('PREPARATION_REQUIRED');
    expect(rejected.json().message).toMatch(/coverage.*2024~2025년.*000660/);
    expect(ctx.container.jobQueue.listJobs(100, 0)).toHaveLength(beforeCount);
  });

  /**
   * topN > maxPositions 는 결과를 조용히 틀리게 만든다 — 초과분은 리스크 검증에서
   * 폐기되고 다음 리밸런스까지 재시도되지 않는데, 비중은 여전히 equity/topN 이라
   * 자본의 일부가 영구히 현금으로 남는다. 기본값 조합(topN=20, 웹 마법사 maxPositions=10)이
   * 정확히 이 상태였다.
   */
  function momentumPayload(topN: number, maxPositions: number): Record<string, unknown> {
    return {
      strategyId: 'cross-sectional-momentum',
      parameters: {
        formationDays: 20,
        skipDays: 0,
        topN,
        rebalanceMonths: 1,
        absoluteMomentumFilter: true,
      },
      universeRule: universeRule(topN),
      timeframe: '1d',
      period: { from: '2025-08-01', to: '2025-10-31' },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
      },
      risk: { maxPositions },
      randomSeed: 42,
    };
  }

  it('topN 이 최대 동시 보유 종목 수보다 크면 공유 요청 스키마에서 400 으로 거부한다', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: momentumPayload(20, 10),
    });

    expect(response.statusCode).toBe(400);
    const error = response.json().error as string;
    expect(error).toContain('전략 topN은 동시 보유 상한 이하여야 합니다');
  });

  it('topN === maxPositions 는 통과한다 — 게이트가 전부를 막지 않는다', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: momentumPayload(1, 1),
    });
    expect(response.statusCode).toBe(201);
  });

  it('봉만 쓰는 전략은 재무 없이도 제출된다', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        strategyId: 'cross-sectional-momentum',
        parameters: {
          formationDays: 20,
          skipDays: 0,
          topN: 1,
          rebalanceMonths: 1,
          absoluteMomentumFilter: true,
        },
        universeRule: universeRule(1),
        timeframe: '1d',
        period: { from: '2025-08-01', to: '2025-10-31' },
        capital: { initialCash: 10_000_000, currency: 'KRW' },
        execution: {
          fillTiming: 'NEXT_BAR_OPEN',
          commissionProfileId: 'kr-equity-default',
          slippageProfileId: 'fixed-5bps',
        },
        risk: { maxPositions: 20 },
        randomSeed: 42,
      },
    });

    expect(response.statusCode).toBeLessThan(400);
  });
});

/**
 * 부모-자식 프로세스 봉 조회 회귀. `ctx.container.jobOrchestrator.tick()` 이 실제로
 * 자식 프로세스를 fork 한다. 자식이 부모와 별도로 `krx_daily_bars` 를 읽어 백테스트를
 * 완주하는지는 이 테스트만 검증한다 — 부모 프로세스 안에서 도는 단위 테스트는 이
 * 경계를 볼 수 없다.
 * `krx_daily_bars` 를 봉 원천으로 사용한다.
 */
describe('KRX 전용 일봉으로 백테스트 실행 (워커의 부모-자식 경계)', () => {
  const KRX_ONLY_CODE = '900001'; // 상장폐지 종목을 흉내낸 임의 코드

  let ctx: TestApp;
  let cookie: string;
  let krxOnlyCandles: Candle[];

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
    installPreparedSubmissionFixture(ctx);

    registerSymbols(ctx.container, 'KR', [KRX_ONLY_CODE]);
    seedSymbolMasterUniverse(ctx.container, MASTER_DATES, [
      {
        standardCode: 'KR7900001008',
        shortCode: KRX_ONLY_CODE,
        name: '상장폐지테스트',
        market: 'KOSPI',
        marketCapKrw: '500000000000000',
      },
    ]);

    krxOnlyCandles = buildDailyCandles(KRX_ONLY_CODE);
    seedDailyBars(ctx.container.database.db, krxOnlyCandles);
    // 자본변동 게이트(Task 6) — 상장폐지 종목이라도 수집 자체는 마쳤다고 가정한다
    await seedCorporateActionCoverage(ctx.container, [KRX_ONLY_CODE], yearRange(2025, 2026));
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('재무 fact가 없고 KRX 일봉만 있는 종목도 워커에서 체결까지 완주한다', { timeout: 90_000 }, async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(1),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    const job = ctx.container.jobQueue.getJob(jobId)!;
    // 회귀 지점: 워커가 KRX 일봉을 읽지 않으면 여기서 '데이터가 없습니다'로 실패한다.
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');
    expect(job.totalBars).toBe(krxOnlyCandles.length);

    // "생존편향 제거가 실제로 동작한다"의 증거 — 실제 체결(거래)까지 나와야 한다
    const { total: tradeCount } = ctx.container.resultsService.getTrades(jobId, {
      limit: 1,
      offset: 0,
    });
    expect(tradeCount).toBeGreaterThan(0);
  });
});

/**
 * clone 의 유니버스 등록 누락이다(리뷰 finding, 브랜치 fix/inplace-candle-sync).
 * `POST /backtests/universe-preview` 는 `registerUniverseSymbols` 를 부른다.
 * 상세 화면의 원클릭 복제(`POST /backtests/:id/clone`)는 `validateSubmission` 만
 * 거쳐 이 호출을 건너뛰었다.
 *
 * 위저드 화면은 제출 전 항상 미리보기를 거치므로 이 등록이 이미 끝나 있다.
 * 복제는 미리보기 화면 자체를 거치지 않는다. 리밸런스 시점 시총이 바뀌어 새로
 * topN 에 든 종목처럼, 미리보기에서 한 번도 보지 못한 종목이 있으면 문제가 된다.
 * `checkPeriodCoverage` 는 미등록 종목을 0봉으로 취급해 엄격히 거부하므로,
 * 복제 경로도 검증 전에 확정 유니버스를 등록해야 한다.
 *
 * 이 테스트는 미리보기를 거치지 않고(검증을 우회해 큐에 직접 넣어) 만든 잡을
 * 복제한다. 이미 등록된 종목(005930) 옆에 미등록 종목 900010(KRX 일봉만 있음)을
 * 둔다. 900010 은 로컬 등록이 없다.
 *
 * 등록은 clone 핸들러가 기간별 일봉 검증보다 먼저 실행한다 —
 * 그래서 KRX 일봉이 있는 900010은 검증과 로컬 종목 목록 모두에서 정상 종목이다.
 * 수정 전에는 clone 이 201 로 성공하면서도 900010 을 등록하지 않아 등록 단언이
 * 실패했다 — 지금은 그 등록이 준비 완료 시점에 실제로 일어나는지를 지킨다.
 *
 * 자본변동 수집 게이트(Task 6)는 Task 10에서 없앴다 — 준비
 * (`buildBacktestPreparationPlan`)가 이미 최종 유니버스의 자본변동을 동기화해
 * 두므로, 제출·복제 시점에 커버리지를 다시 대조하지 않는다.
 */
describe('POST /backtests/:id/clone — 유니버스 자동 등록 (미리보기와 같은 전제)', () => {
  const date = '2026-01-05';

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
    installPreparedSubmissionFixture(ctx);

    // 시총 순위: 900010(상장폐지 예정, 미등록) > 005930(이미 등록·커버리지 있음) —
    // topN=2 유니버스 규칙이 둘 다 고른다.
    seedSymbolMasterUniverse(ctx.container, [date], [
      {
        standardCode: 'KR7900010009',
        shortCode: '900010',
        name: '상장폐지예정1호',
        market: 'KOSPI',
        marketCapKrw: '2000000000000000',
      },
      {
        standardCode: 'KR7005930003',
        shortCode: '005930',
        name: '삼성전자',
        market: 'KOSPI',
        marketCapKrw: '500000000000000',
      },
    ]);

    // 005930 은 예전에 미리보기를 거쳐 이미 등록·커버리지가 있다고 가정한다.
    registerSymbols(ctx.container, 'KR', ['005930']);
    seedDailyBars(ctx.container.database.db, [
      {
        symbol: '005930',
        market: 'KR',
        timeframe: '1d',
        tsMs: Date.UTC(2026, 0, 5),
        open: 1_000,
        high: 1_100,
        low: 900,
        close: 1_050,
        volume: 12_345,
      },
    ]);

    // 900010 은 백필이 KRX 일봉을 이미 채워 뒀다고 가정한다(krx_daily_bars 직접
    // 삽입) — 다만 이 종목은 미리보기를 한 번도 거치지 않아 로컬 `symbols` 등록이
    // 없다.
    ctx.container.database.db
      .insert(krxDailyBars)
      .values({
        shortCode: '900010',
        date,
        market: 'KOSPI',
        open: 1_000,
        high: 1_100,
        low: 900,
        close: 1_050,
        volume: 12_345,
      })
      .run();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('복제도 동일 hash 준비 완료 전에는 409이고 완료 뒤 unionSymbols 를 등록한다(Task 6)', async () => {
    expect(ctx.container.symbolService.exists('900010')).toBe(false);

    // 위저드의 미리보기를 거치지 않고 제출된 잡을 재현한다 — clone-draft 테스트와
    // 같은 패턴으로 검증을 우회해 큐에 직접 넣는다.
    const request: BacktestRequest = {
      ...singleDayRequest(2, date),
      timeframe: '1d',
    };
    const job = ctx.container.jobQueue.enqueue(request, [], { entries: [], hash: 'seed' });

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });

    // 복제도 새 제출과 같은 durable preparation을 먼저 요구한다. 완료 전에는 resolver
    // 결과를 임의 등록하거나 queue에 넣지 않는다.
    expect(cloned.statusCode).toBe(409);
    expect((cloned.json() as { error: string }).error).toBe('PREPARATION_REQUIRED');
    expect(ctx.container.symbolService.exists('900010')).toBe(false);

    const preparation = ctx.container.backtestPreparationOrchestrator.start({
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    });
    await waitFor(() => {
      const status = ctx.container.backtestPreparationOrchestrator.get(preparation.id)?.status;
      return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
    }, 5_000);
    expect(ctx.container.backtestPreparationOrchestrator.get(preparation.id)?.status).toBe('COMPLETED');

    // 최종 READY schedule을 확정할 때 등록한다. 이 경계가 preview/submit/clone 모두에
    // 하나뿐이므로 가격 데이터 탭과 실행 pin이 갈라지지 않는다.
    expect(ctx.container.symbolService.exists('900010')).toBe(true);
    const coverage = ctx.container.candleCoverageService.getCoverage(['900010'])[0]!;
    expect(coverage.barCount).toBe(1);

    // 자본변동 수집 게이트(Task 6)는 없앴다(Task 10) — 준비가 COMPLETED 라는
    // 사실만으로 같은 요청의 복제가 곧바로 통과한다.
    const afterPreparation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(afterPreparation.statusCode).toBe(201);
  });
});

/**
 * `checkPeriodCoverage`/`resolveConsumedUniverse` 는 봉 커버리지뿐 아니라 종목 등록도
 * 확인해, 미등록 유니버스가 큐에 들어가기 전에 거부한다.
 *
 * `registerSymbols` 를 의도적으로 부르지 않는다 — `krx_daily_bars` 는 백필이 이미
 * 채워 뒀다고 가정하지만 `symbols` 등록은 한 번도 거치지 않은 상태를 재현한다.
 */
describe('POST /backtests — 미등록 유니버스 검증', () => {
  const date = '2026-01-05';
  const UNREGISTERED_CODE = '900099';

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

    seedSymbolMasterUniverse(ctx.container, [date], [
      {
        standardCode: 'KR7900099005',
        shortCode: UNREGISTERED_CODE,
        name: '미등록테스트',
        market: 'KOSPI',
        marketCapKrw: '500000000000000',
      },
    ]);

    // krx_daily_bars 에는 봉이 있다 — 등록 게이트가 아니라면 이 봉만으로 제출이
    // 통과해 버린다는 것을 보여주려는 픽스처다.
    ctx.container.database.db
      .insert(krxDailyBars)
      .values({
        shortCode: UNREGISTERED_CODE,
        date,
        market: 'KOSPI',
        open: 1_000,
        high: 1_100,
        low: 900,
        close: 1_050,
        volume: 12_345,
      })
      .run();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('종목이 봉을 갖고 있어도 준비 완료 전에는 409이고 등록·큐 변경이 없다', async () => {
    expect(ctx.container.symbolService.exists(UNREGISTERED_CODE)).toBe(false);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: singleDayRequest(1, date),
    });

    expect(created.statusCode).toBe(409);
    expect((created.json() as { error: string }).error).toBe('PREPARATION_REQUIRED');
    expect(ctx.container.symbolService.exists(UNREGISTERED_CODE)).toBe(false);
    // 큐에 남지 않아야 한다 — 늦게 죽는 게 아니라 애초에 들어가지 않아야 한다.
    expect(ctx.container.jobQueue.countByStatus(['QUEUED'])).toBe(0);
  });
});

/**
 * 워커 배선(Task 10) — 데이터 계층·유니버스·엔진(Task 4·6·7·8·9)은 이미 준비됐지만
 * 아무도 그 정보를 엔진에 넘기지 않으면 실제 백테스트에서는 아무 것도 바뀌지 않는다.
 * 이 테스트가 `backtest-child.ts` 가 실제로 그 배선을 잇는지 end-to-end 로 확인하는
 * 유일한 자리다.
 */
describe('상장폐지 종목 청산 (Task 10 워커 배선)', () => {
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
    installPreparedSubmissionFixture(ctx);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it(
    '보유 종목 봉이 원인 없이 끊기면 워커가 마지막 가격 평가로 완료하지 않는다',
    { timeout: 90_000 },
    async () => {
      const alive = buildDailyCandles('005930');
      const incomplete = buildDailyCandles('000660').slice(0, Math.floor(alive.length / 2));

      registerSymbols(ctx.container, 'KR', ['005930', '000660']);
      seedDailyBars(ctx.container.database.db, [...alive, ...incomplete]);
      seedSymbolMasterUniverse(ctx.container, MASTER_DATES, [
        { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '900' },
        { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSPI', marketCapKrw: '800' },
      ]);
      await seedCorporateActionCoverage(ctx.container, ['005930', '000660'], yearRange(2025, 2026));

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: buildRequest(2),
      });
      expect(created.statusCode).toBe(201);
      const jobId = (created.json().job as { id: string }).id;

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      expect(job.status).toBe('FAILED');
      expect(job.error).toContain('보유 종목의 가격 봉이 거래일 중간에 누락됐습니다: 000660');
      expect(ctx.container.resultsService.getRun(jobId)).toBeNull();
    },
  );

  it(
    '상장폐지 종목이 마지막 거래 가능 봉 종가로 청산된다',
    { timeout: 90_000 },
    async () => {
      const alive = buildDailyCandles('005930');
      // 000660 은 기간의 절반까지만 거래된다 — 그 뒤 폐지된다
      const doomedAll = buildDailyCandles('000660');
      const doomed = doomedAll.slice(0, Math.floor(doomedAll.length / 2));
      const lastDoomed = doomed[doomed.length - 1]!;
      // 마지막 봉의 시가·종가가 달라야 "종가로 나갔다"를 증명할 수 있다
      expect(lastDoomed.open).not.toBe(lastDoomed.close);

      registerSymbols(ctx.container, 'KR', ['005930', '000660']);
      seedDailyBars(ctx.container.database.db, [...alive, ...doomed]);
      seedSymbolMasterUniverse(ctx.container, MASTER_DATES, [
        { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '900' },
        { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSPI', marketCapKrw: '800' },
      ]);
      await seedCorporateActionCoverage(ctx.container, ['005930', '000660'], yearRange(2025, 2026));

      // 마지막 봉 다음 날을 폐지 효력일로 둔다. delistedEventsBetween 은
      // symbol_master_versions 의 버전 경계로 이벤트를 파생하므로 000660 의 실제
      // 유효 구간을 이 날짜에서 닫는다. observedSpanStart 앵커(경계 이전 관측
      // 거래일)는 seedSymbolMasterUniverse 가 MASTER_DATES 를 이미 거래일로 심어
      // 뒀으므로 따로 채울 필요가 없다.
      const delistedDate = new Date(lastDoomed.tsMs + DAY).toISOString().slice(0, 10);
      const delistedTsMs = Date.parse(`${delistedDate}T00:00:00Z`);
      ctx.container.database.db
        .update(symbolMasterVersions)
        .set({ validToDate: delistedDate })
        .where(
          and(
            eq(symbolMasterVersions.standardCode, 'KR7000660001'),
            isNull(symbolMasterVersions.validToDate),
          ),
        )
        .run();

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: buildRequest(2),
      });
      expect(created.statusCode).toBe(201);
      const jobId = (created.json().job as { id: string }).id;

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      expect(job.error).toBeNull();
      expect(job.status).toBe('COMPLETED');

      const { trades } = ctx.container.resultsService.getTrades(jobId, { limit: 1000, offset: 0 });
      // 전략이 000660 을 실제로 샀는지부터 확인한다 — 안 사면 청산 단언이 공허해진다
      expect(trades.some((trade) => trade.symbol === '000660')).toBe(true);

      const delistingTrade = trades.find(
        (trade) => trade.symbol === '000660' && trade.exitReason === 'DELISTED',
      );
      expect(delistingTrade).toBeDefined();

      // 체결가는 마지막 봉의 **종가** 를 기준으로 슬리피지를 적용한 값이어야 한다 —
      // buildRequest 가 쓰는 실행 프로필(fixed-5bps)은 슬리피지가 0이 아니므로 종가와
      // 정확히 같지는 않다. 시가를 기준으로 계산한 값과 달라야 "종가로 나갔다"를 증명한다.
      const executionProfile = {
        cost: getCostProfile('kr-equity-default')!,
        slippage: getSlippageProfile('fixed-5bps')!,
        rules: getKrxExecutionRules('KOSPI'),
      };
      const expectedFromClose = simulateFill(
        { symbol: '000660', side: 'SELL', quantity: 1, reason: 'DELISTED' },
        lastDoomed.close,
        delistedTsMs,
        executionProfile,
      );
      const expectedFromOpen = simulateFill(
        { symbol: '000660', side: 'SELL', quantity: 1, reason: 'DELISTED' },
        lastDoomed.open,
        delistedTsMs,
        executionProfile,
      );
      expect(delistingTrade?.exitPrice).toBe(expectedFromClose.price);
      expect(delistingTrade?.exitPrice).not.toBe(expectedFromOpen.price);
      expect(delistingTrade?.exitTsMs).toBe(delistedTsMs);

      // 청산했으므로 기간 종료 시점 미청산 포지션으로 남지 않는다
      const run = ctx.container.resultsService.getRun(jobId)!;
      const openPositions = JSON.parse(run.openPositionsJson ?? '[]') as { symbol: string }[];
      expect(openPositions.some((position) => position.symbol === '000660')).toBe(false);

      // 이 테스트는 거래불가일 커버리지를 심지 않는다 — nonTradingCoveredPeriod 가
      // null 로 넘어와야 하고, 엔진은 그 상태를 "정보가 없다" 경고로 명시해야 한다.
      // 세 값(null/미지정/구간)을 가르는 유일한 관측 지점이 이 경고 문구다.
      const warnings = JSON.parse(run.warningsJson ?? '[]') as string[];
      expect(warnings.some((w) => w.includes('거래불가일 정보가 없습니다'))).toBe(true);
    },
  );

  it(
    '거래불가일에는 매수 후보에서 빠지고, 커버리지가 있으면 구간을 명시한 경고만 남는다',
    { timeout: 90_000 },
    async () => {
      const alive = buildDailyCandles('005930');
      const nonTradingSymbolCandles = buildDailyCandles('000660');

      registerSymbols(ctx.container, 'KR', ['005930', '000660']);
      seedDailyBars(ctx.container.database.db, [...alive, ...nonTradingSymbolCandles]);
      seedSymbolMasterUniverse(ctx.container, MASTER_DATES, [
        { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '900' },
        { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSPI', marketCapKrw: '800' },
      ]);
      await seedCorporateActionCoverage(ctx.container, ['005930', '000660'], yearRange(2025, 2026));

      // 이 픽스처(range-breakout, topN=2, 두 종목 모두 buildDailyCandles 의 동일한
      // 가격 패턴)에서 두 종목은 항상 2025-08-12 에 첫 진입한다 — 신호는 전날
      // (2025-08-11, lookbackBars=10 을 처음 채우는 봉)에 나고 NEXT_BAR_OPEN 으로
      // 다음 거래일 시가에 체결된다. 000660 의 신호일(08-11)만 거래불가로 막아
      // 그 진입 하나만 지연되는지 본다 — 워커가 tsMs 를 하루라도 다르게 구성했다면
      // (Candle.tsMs 와 다른 규칙을 썼다면) 이 필터가 08-11 이 아닌 다른 날에 걸려
      // 000660 도 005930 과 함께 08-12 에 그대로 들어가 버린다.
      ctx.container.database.db
        .insert(krxNonTradingDays)
        .values({ date: '2025-08-11', shortCode: '000660', market: 'KOSPI', lastClose: 1 })
        .run();
      ctx.container.database.db
        .insert(krxNonTradingCoverage)
        .values({ startDate: '2025-07-27', endDate: '2026-07-24', syncedAtMs: 0 })
        .run();

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: buildRequest(2),
      });
      expect(created.statusCode).toBe(201);
      const jobId = (created.json().job as { id: string }).id;

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      expect(job.error).toBeNull();
      expect(job.status).toBe('COMPLETED');

      const { trades } = ctx.container.resultsService.getTrades(jobId, { limit: 1000, offset: 0 });
      const blockedEntryTsMs = Date.UTC(2025, 7, 12); // 2025-08-12, 막지 않았다면 둘 다 여기서 들어간다

      // 대조군: 거래불가로 막지 않은 005930 은 예정대로 그날 들어간다.
      expect(trades.some((t) => t.symbol === '005930' && t.entryTsMs === blockedEntryTsMs)).toBe(
        true,
      );
      // 000660 은 그날 들어가지 않는다 — 매수 후보에서 빠졌다는 증거다.
      expect(trades.some((t) => t.symbol === '000660' && t.entryTsMs === blockedEntryTsMs)).toBe(
        false,
      );
      // 그날만 진입을 미룰 뿐 매수 자체를 영영 막지는 않는다.
      expect(trades.some((t) => t.symbol === '000660')).toBe(true);

      // 실행 기간이 전부 덮였으므로 커버리지 이야기는 한 줄도 나오지 않는다 —
      // "정보가 없습니다" 도, 구간을 다시 읊는 "…구간만 반영됐습니다" 도 거짓이다.
      const run = ctx.container.resultsService.getRun(jobId)!;
      const warnings = JSON.parse(run.warningsJson ?? '[]') as string[];
      expect(warnings.some((w) => w.includes('거래불가일 정보가 없습니다'))).toBe(false);
      expect(warnings.some((w) => w.includes('거래불가일 정보는'))).toBe(false);
    },
  );

  it(
    '리밸런스 기준일에 거래정지인 종목은 유니버스 후보에서 빠지고 실행 경고로 남는다 (Task 11)',
    { timeout: 90_000 },
    async () => {
      const alive = buildDailyCandles('005930');
      registerSymbols(ctx.container, 'KR', ['005930', '000660']);
      seedDailyBars(ctx.container.database.db, alive);
      seedSymbolMasterUniverse(ctx.container, MASTER_DATES, [
        { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '900' },
        { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSPI', marketCapKrw: '800' },
      ]);
      await seedCorporateActionCoverage(ctx.container, ['005930', '000660'], yearRange(2025, 2026));

      // 이 테스트는 리밸런싱 없음(NONE)으로 period.from(2025-07-27) 한 번만 고른다.
      // 그 날짜에 000660 을 거래정지로 심으면
      // UniverseRuleResolver.resolve() 가 후보에서 빼고 excludedNonTradingCount 를 센다 —
      // 000660 은 봉이 없어도 상관없다(유니버스에 아예 들어오지 못하므로).
      ctx.container.database.db
        .insert(krxNonTradingDays)
        .values({ date: '2025-07-27', shortCode: '000660', market: 'KOSPI', lastClose: 1 })
        .run();

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: {
          ...buildRequest(2),
          universeRule: {
            ...buildRequest(2).universeRule,
            rebalanceInterval: { unit: 'NONE', value: 1 },
          },
        },
      });
      expect(created.statusCode).toBe(201);
      const jobId = (created.json().job as { id: string }).id;

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      expect(job.error).toBeNull();
      expect(job.status).toBe('COMPLETED');

      // 실제로 후보에서 빠졌다는 증거 — 그 리밸런스에서 거래정지가 아니었다면
      // topN=2 라 000660 도 유니버스에 들어와 거래가 났을 것이다.
      const { trades } = ctx.container.resultsService.getTrades(jobId, { limit: 1000, offset: 0 });
      expect(trades.some((t) => t.symbol === '000660')).toBe(false);

      const run = ctx.container.resultsService.getRun(jobId)!;
      const warnings = JSON.parse(run.warningsJson ?? '[]') as string[];
      expect(
        warnings.some((w) =>
          w.includes('리밸런스 기준일에 거래정지·무거래여서 유니버스 후보에서 제외된 종목 1건'),
        ),
      ).toBe(true);
    },
  );
});

/**
 * Task 12 — preview→prepare→submit→run 전체 회귀. KOSPI `시가총액 5 → PER 3 →
 * 급하락(20) 2` 3단계 규칙(매월 rule)을 실제 durable preparation job(202)부터
 * 완주까지 한 번에 태운다.
 *
 * 후보 7종목으로 단계별 배제를 실제로 겪는다: F·G는 시가총액 stage에서 이미
 * 빠지고, D·E는 시가총액 top5(A~E)에는 들되 재무(NET_INCOME)가 없어 PER stage에서
 * 빠진다 — 그래서 DART(financial fact) 요청은 정확히 {A,B,C,D,E} 만 받아야 한다(F·G는
 * 결코 요청되지 않는다). 급하락(20일) stage는 A·B·C 세 종목의 가격 추이를 서로 다르게
 * 둬 리밸런스 1(1월)엔 {A,B}, 리밸런스 2(2월)엔 {B,C}가 선정되도록 만든다 — A는
 * 멤버십을 잃고, C는 새로 들어온다.
 *
 * 전략은 `low-per-high-roe-rank` 를 쓴다: 가격 패턴에 기대는 기술적 전략과 달리
 * 이 전략은 "그 시점 유니버스 멤버 중 유효 후보를 그대로 산다" 는 결정적 규칙이라
 * REBALANCE_EXIT(멤버십 이탈)을 가격 신호 타이밍 없이 재현할 수 있다. NET_INCOME은
 * PER stage(유니버스)와 이 전략의 순위 계산이 함께 쓴다 — 실전에서도 같은 재무
 * 원천을 공유하므로 이 픽스처가 그 배선을 그대로 반영한다.
 *
 * DART는 실제 HTTP 요청 없이 `factSyncService.sync` 를 스파이로 감싼다 — 위
 * `installPreparedSubmissionFixture` 류와 같은 관례(이 파일 상단)를 따르되, 이번엔
 * 완전한 no-op이 아니라 실제로 NET_INCOME을 저장하고 coverage를 기록해 "각 phase가
 * 정확히 어떤 symbol을 요청했는지" 를 관찰할 수 있게 한다.
 */
describe('유니버스 준비 파이프라인 전체 회귀 — preview→prepare→submit→run (Task 12)', () => {
  const STEP12_DAY = 86_400_000;
  /** 급하락(20일) stage의 조회 하한(effectiveDate - 54일) 보다 이르게 잡은 캔들 시작점 */
  const STEP12_CANDLE_START = Date.UTC(2024, 9, 1); // 2024-10-01
  const STEP12_REBALANCE_1 = '2025-01-02';
  const STEP12_REBALANCE_2 = '2025-02-02';
  const STEP12_PERIOD = { from: STEP12_REBALANCE_1, to: '2025-02-10' };
  /** NET_INCOME 공시 시각 — PIT 은 이 test의 관심사가 아니므로 두 리밸런스보다 훨씬 이르게 고정한다 */
  const STEP12_DISCLOSED_TS = Date.UTC(2024, 0, 1);

  const THREE_STAGE_RULE: BacktestRequest['universeRule'] = {
    markets: ['KOSPI'],
    stages: [
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 5 },
      { criterion: 'PER', direction: 'LOW', limit: 3 },
      { criterion: 'DECLINE', direction: 'LOW', limit: 2, lookbackTradingDays: 20 },
    ],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  };

  function step12PreviewInput() {
    return {
      universeRule: THREE_STAGE_RULE,
      period: STEP12_PERIOD,
      strategyId: 'low-per-high-roe-rank',
      parameters: { topN: 2, staleQuarters: 8 },
    };
  }

  /** fromMs~toMs 구간의 모든 캘린더 날짜 — 이 픽스처는 스스로 정의하는 합성 거래일력이라 요일을 가리지 않는다 */
  function step12AllDates(fromMs: number, toMs: number): string[] {
    const dates: string[] = [];
    for (let ts = fromMs; ts <= toMs; ts += STEP12_DAY) dates.push(new Date(ts).toISOString().slice(0, 10));
    return dates;
  }

  /** anchor 두 점 사이는 선형보간, 바깥은 양끝 값으로 고정한다 */
  function linearBetween(fromMs: number, fromPrice: number, toMs: number, toPrice: number, tsMs: number): number {
    if (tsMs <= fromMs) return fromPrice;
    if (tsMs >= toMs) return toPrice;
    return fromPrice + (toPrice - fromPrice) * ((tsMs - fromMs) / (toMs - fromMs));
  }

  /**
   * A·B·C의 20일 급락 순위가 리밸런스 1→2 사이에 뒤집히도록 가격을 설계한다:
   * - A: 리밸런스 1 직전 20일 동안 2000→1000(-50%)으로 급락한 뒤, 리밸런스 2 직전
   *   20일 구간(1/14~2/2)은 2000 평탄(0%) — 리밸런스 1에서만 급락 상위다.
   * - C: 리밸런스 1 직전 20일은 2000 평탄(0%), 리밸런스 2 직전 20일(1/14~2/2)에
   *   2000→1000(-50%) 으로 급락 — 리밸런스 2에서만 급락 상위다.
   * - B: 항상 완만하게 하락해(-0.3%대) 두 리밸런스 모두 A/C의 급락(-50%)과 무하락
   *   (0%) 사이의 중간 순위를 지킨다 — 매번 두 자리 중 하나를 차지한다.
   */
  function decliningPriceAt(symbol: 'A' | 'B' | 'C', tsMs: number): number {
    const jan2 = Date.parse('2025-01-02T00:00:00Z');
    const jan14 = Date.parse('2025-01-14T00:00:00Z');
    const dec14 = Date.parse('2024-12-14T00:00:00Z');
    const feb2 = Date.parse('2025-02-02T00:00:00Z');
    if (symbol === 'A') {
      if (tsMs <= dec14) return 2000;
      if (tsMs < jan2) return linearBetween(dec14, 2000, jan2, 1000, tsMs);
      if (tsMs < jan14) return linearBetween(jan2, 1000, jan14, 2000, tsMs);
      return 2000;
    }
    if (symbol === 'C') {
      if (tsMs < jan14) return 2000;
      if (tsMs < feb2) return linearBetween(jan14, 2000, feb2, 1000, tsMs);
      return 1000;
    }
    const daysSinceStart = (tsMs - STEP12_CANDLE_START) / STEP12_DAY;
    return 3000 - 0.4 * daysSinceStart;
  }

  let ctx: TestApp;
  let cookie: string;
  let dartCalls: string[][];

  /**
   * 실제 DART 네트워크 없이 `factSyncService.sync` 만 감싼다 — 요청받은 symbol을
   * 기록하고(브리프의 `fakeDart.requestedSymbols()`/`callCount()` 에 대응), NET_INCOME
   * 이 있는 symbol(A·B·C)만 실제로 저장한다. D·E는 재무가 전혀 없다고 응답하되
   * "시도했다" 는 coverage 만 남겨 오케스트레이터가 같은 요청을 영원히 반복하지 않게 한다 —
   * 실제 DART도 신규상장·미제출 분기에서 이렇게 응답한다(§013 무자료 상태).
   */
  function installDartFinancialSpy(netIncomeBySymbol: ReadonlyMap<string, number>): void {
    ctx.container.factSyncService.sync = (async (request: FactSyncRequest): Promise<FactSyncReport> => {
      dartCalls.push([...request.symbols]);
      const facts: Fact[] = [];
      for (const symbol of request.symbols) {
        const income = netIncomeBySymbol.get(symbol);
        if (income !== undefined) {
          for (let offset = 0; offset < 4; offset += 1) {
            facts.push({
              scope: 'SYMBOL',
              key: symbol,
              field: 'NET_INCOME',
              periodKey: `202${4 - Math.floor(offset / 4)}Q${4 - (offset % 4)}`,
              asOfTsMs: STEP12_DISCLOSED_TS,
              value: income,
              unit: 'KRW',
            });
          }
        }
      }
      if (facts.length > 0) await ctx.container.factRepository.saveFacts(facts);
      for (const symbol of request.symbols) {
        ctx.container.factCoverageStore.addCoverageResult(
          symbol,
          [2024, 2025],
          [],
          ctx.container.clock.now(),
        );
      }
      return { savedFacts: facts.length, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null };
    }) as typeof ctx.container.factSyncService.sync;
  }

  beforeEach(async () => {
    ctx = await createTestApp();
    dartCalls = [];
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    // 자본변동은 이 test의 관심사가 아니다 — A·B·C(급하락 stage까지 도달하는 후보)만
    // 직접 커버리지를 심어 DART 왕복 없이 통과시킨다(이 파일 상단 관례와 동일).
    ctx.container.factSyncService.syncCorporateActions = (async () => ({
      savedFacts: 0,
      gaps: [],
      stoppedAtSymbol: null,
      stopReason: null,
      failureMessage: null,
    })) as typeof ctx.container.factSyncService.syncCorporateActions;
    ctx.container.factSyncService.planFinancialSync = (() => ({
      yearsBySymbol: new Map(),
      shareYearsBySymbol: new Map(),
      todayKstDate: '2026-01-01',
      calls: 0,
      estimatedMs: 0,
      overDailyLimit: false,
    })) as typeof ctx.container.factSyncService.planFinancialSync;
    ctx.container.factSyncService.planCorporateActionSync = ctx.container.factSyncService.planFinancialSync;
    installDartFinancialSpy(new Map([['A', 500_000], ['B', 400_000], ['C', 300_000]]));

    registerSymbols(ctx.container, 'KR', ['A', 'B', 'C', 'D', 'E']);
    seedSymbolMasterUniverse(
      ctx.container,
      step12AllDates(STEP12_CANDLE_START, Date.parse(`${STEP12_PERIOD.to}T00:00:00Z`)),
      [
        { standardCode: 'KR7000001000', shortCode: 'A', name: 'A', market: 'KOSPI', marketCapKrw: '500' },
        { standardCode: 'KR7000002000', shortCode: 'B', name: 'B', market: 'KOSPI', marketCapKrw: '400' },
        { standardCode: 'KR7000003000', shortCode: 'C', name: 'C', market: 'KOSPI', marketCapKrw: '300' },
        { standardCode: 'KR7000004000', shortCode: 'D', name: 'D', market: 'KOSPI', marketCapKrw: '200' },
        { standardCode: 'KR7000005000', shortCode: 'E', name: 'E', market: 'KOSPI', marketCapKrw: '100' },
        // F·G는 시가총액 5위(=E) 보다 낮아 첫 stage에서 이미 떨어진다 — 이후 어떤 phase 도
        // 이 둘을 요청하지 않는다.
        { standardCode: 'KR7000006000', shortCode: 'F', name: 'F', market: 'KOSPI', marketCapKrw: '50' },
        { standardCode: 'KR7000007000', shortCode: 'G', name: 'G', market: 'KOSPI', marketCapKrw: '40' },
      ],
    );

    const candles: Candle[] = [];
    for (const symbol of ['A', 'B', 'C'] as const) {
      for (let ts = STEP12_CANDLE_START; ts <= Date.parse(`${STEP12_PERIOD.to}T00:00:00Z`); ts += STEP12_DAY) {
        const close = decliningPriceAt(symbol, ts);
        candles.push({ symbol, market: 'KR', timeframe: '1d', tsMs: ts, open: close, high: close, low: close, close, volume: 1_000 });
      }
    }
    seedDailyBars(ctx.container.database.db, candles);
    // 자본총계는 coverage 게이트가 없다 — DART 스파이와 무관하게 미리 심어 둔다
    // (이 test의 관심사는 PER/급하락 stage 와 REBALANCE_EXIT 이다, PIT 은 Task 12의
    // 재무전략 회귀 test(backtest-facts-worker.test.ts)가 이미 검증한다).
    await ctx.container.factRepository.saveFacts(
      (['A', 'B', 'C'] as const).map((symbol) => ({
        scope: 'SYMBOL' as const,
        key: symbol,
        field: 'TOTAL_EQUITY' as const,
        periodKey: '2024Q4',
        asOfTsMs: STEP12_DISCLOSED_TS,
        value: 1_000_000,
        unit: 'KRW',
      })),
    );
    await seedCorporateActionCoverage(ctx.container, ['A', 'B', 'C'], yearRange(2024, 2025));
  });

  afterEach(async () => {
    await ctx.close();
  });

  it(
    '전체 파이프라인이 preview→durable prepare→idempotent 재조회→submit→run→REBALANCE_EXIT 을 한 번에 완주한다',
    { timeout: 90_000 },
    async () => {
      // 1~4. 202 job 을 시작해 COMPLETED 까지 기다린 뒤 단계별 진단을 확인한다
      const started = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests/universe-preview',
        cookies: { qp_session: cookie },
        payload: step12PreviewInput(),
      });
      expect(started.statusCode).toBe(202);
      const jobId = (started.json() as { job: { id: string } }).job.id;
      const completed = await waitForPreparation(jobId);
      expect(completed).toBe('COMPLETED');

      // 3. DART(재무)는 두 phase로만 불린다 — F·G는 어느 phase에도 등장하지 않는다.
      // ① 유니버스 PER stage의 필요(시가총액 top5 = A~E) ② 전략(저PER·고ROE)이
      // 최종 확정 유니버스(A~C)에 요구하는 재무(dataRequirements.fundamentalLookbackQuarters)
      expect(dartCalls).toHaveLength(2);
      expect([...dartCalls[0]!].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect([...dartCalls[1]!].sort()).toEqual(['A', 'B', 'C']);
      const callsAfterFirstPreparation = dartCalls.length;

      const ready = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests/universe-preview',
        cookies: { qp_session: cookie },
        payload: step12PreviewInput(),
      });
      expect(ready.statusCode).toBe(200);
      const preview = ready.json() as {
        schedule: Array<{ rebalanceDate: string; effectiveDate: string; members: Array<{ symbol: string }> }>;
        unionSymbols: string[];
        scheduleHash: string;
        diagnostics: Array<{
          rebalanceDate: string;
          effectiveDate: string;
          stages: Array<{
            criterion: string;
            direction: 'HIGH' | 'LOW';
            inputCount: number;
            eligibleCount: number;
            selectedCount: number;
            excludedMissingCount: number;
          }>;
        }>;
      };

      // 5. 같은 body 재요청은 source 추가 호출 없이 200 READY다
      expect(dartCalls.length).toBe(callsAfterFirstPreparation);

      // 4. preview의 단계별 N·missing 제외 수·effective date
      expect(preview.schedule).toHaveLength(2);
      expect(preview.schedule[0]).toMatchObject({
        rebalanceDate: STEP12_REBALANCE_1,
        effectiveDate: STEP12_REBALANCE_1,
        members: [{ symbol: 'A' }, { symbol: 'B' }],
      });
      expect(preview.schedule[1]).toMatchObject({
        rebalanceDate: STEP12_REBALANCE_2,
        effectiveDate: STEP12_REBALANCE_2,
        members: [{ symbol: 'C' }, { symbol: 'B' }],
      });
      expect(preview.unionSymbols.slice().sort()).toEqual(['A', 'B', 'C']);
      for (const entry of preview.diagnostics) {
        const [marketCap, per, decline] = entry.stages;
        expect(marketCap).toMatchObject({ criterion: 'MARKET_CAP', direction: 'HIGH', inputCount: 7, selectedCount: 5, excludedMissingCount: 0 });
        expect(per).toMatchObject({ criterion: 'PER', direction: 'LOW', inputCount: 5, eligibleCount: 3, selectedCount: 3, excludedMissingCount: 2 });
        expect(decline).toMatchObject({ criterion: 'DECLINE', direction: 'LOW', inputCount: 3, selectedCount: 2 });
      }

      // 6. 백테스트 제출·worker 실행 후 schedule hash와 provenance를 확인한다
      const submitPayload: BacktestRequest = {
        strategyId: 'low-per-high-roe-rank',
        parameters: { topN: 2, staleQuarters: 8 },
        universeRule: THREE_STAGE_RULE,
        timeframe: '1d',
        period: STEP12_PERIOD,
        capital: { initialCash: 10_000_000, currency: 'KRW' },
        execution: {
          fillTiming: 'NEXT_BAR_OPEN',
          commissionProfileId: 'zero-cost',
          slippageProfileId: 'zero-slippage',
        },
        risk: { maxPositions: 2 },
        randomSeed: 1,
      };
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: submitPayload,
      });
      expect(created.statusCode).toBe(201);
      const backtestJobId = (created.json().job as { id: string }).id;
      const stored = ctx.container.jobQueue.getJob(backtestJobId)!;
      const pinnedSchedule = JSON.parse(stored.universeScheduleJson);
      const persistedPin = JSON.parse(stored.provenancePinJson!) as { scheduleHash: string };
      expect(persistedPin.scheduleHash).toBe(
        createHash('sha256').update(JSON.stringify(pinnedSchedule)).digest('hex'),
      );
      // preview와 실행이 같은 UniverseRuleResolver를 쓴다는 증거다. 저장 일정은
      // symbols 모양이고 preview는 members 모양을 보존해 해시 namespace 자체는
      // 다르지만(backtest-routes.ts
      // preparedPreviewToResolved 주석 참고), 멤버십(리밸런스 날짜별 종목 집합)은
      // 정확히 같아야 한다.
      expect(pinnedSchedule.map((entry: { symbols: string[] }) => entry.symbols)).toEqual(
        preview.schedule.map((entry) => entry.members.map((member) => member.symbol)),
      );

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(backtestJobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);
      const job = ctx.container.jobQueue.getJob(backtestJobId)!;
      expect(job.error).toBeNull();
      expect(job.status).toBe('COMPLETED');

      // 7. 첫 리밸런스 뒤 멤버십을 잃는 A의 exit가 REBALANCE_EXIT인지 확인한다
      const { trades } = ctx.container.resultsService.getTrades(backtestJobId, { limit: 1000, offset: 0 });
      const aExit = trades.find((trade) => trade.symbol === 'A');
      expect(aExit).toBeDefined();
      expect(aExit?.exitReason).toBe('REBALANCE_EXIT');

      // B는 두 리밸런스 모두의 멤버라 팔렸다 다시 사지 않고 계속 보유한다(미청산으로 남는다)
      const run = ctx.container.resultsService.getRun(backtestJobId)!;
      const openPositions = JSON.parse(run.openPositionsJson ?? '[]') as Array<{ symbol: string }>;
      expect(openPositions.map((p) => p.symbol).sort()).toEqual(['B', 'C']);
    },
  );

  async function waitForPreparation(jobId: string): Promise<'COMPLETED' | 'FAILED' | 'CANCELLED'> {
    const started = Date.now();
    for (;;) {
      const status = ctx.container.backtestPreparationOrchestrator.get(jobId)?.status;
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') return status;
      if (Date.now() - started > 5_000) throw new Error('preparation timeout');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
});
