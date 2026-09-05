import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_VERSION } from '../../src/server/modules/backtest/domain/engine.js';
import { UnsafeBacktestSymbolIdentityError } from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';
import { FACTS_SLICE } from '../../src/server/modules/market-data/application/symbol-service.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import {
  backtestJobs,
  facts,
  krxDailyBars,
  symbolFactsState,
  symbolMasterCoverage,
  symbolMasterVersions,
  symbols,
  symbolVersions,
} from '../../src/server/shared/db/schema.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import {
  createTestAdmin,
  createTestApp,
  installPreparedSubmissionFixture,
  type TestApp,
} from '../helpers/test-app.js';
import {
  registerSymbols,
  seedCorporateActionCoverage,
  seedDailyBars,
  seedFinancialCoverage,
  seedValueQualityFacts,
  yearRange,
} from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

const DAY = 86_400_000;

const STRATEGY_ID = 'range-breakout';
/** range-breakout 은 rebalanceMonths 가 없다 — 리밸런스는 늘 period.from 하나뿐이다 */
const MAIN_DATE = '2026-01-05';
/** "봉이 전혀 없는 기간" 시나리오 전용 — 종목 마스터는 커버하되(coverage 는 넓은 고정 구간)
 *  가격 데이터가 없는 시점을 재현한다. 커버 밖(uncovered) 날짜와 구분하려고 별도로 캐시한다. */
const NO_CANDLE_DATE = '2020-01-01';
const REBALANCE_DATES = [
  MAIN_DATE,
  '2026-02-05',
  '2026-03-05',
  '2026-04-05',
  '2026-05-05',
  '2026-06-05',
  '2026-01-06',
  '2026-01-07',
  NO_CANDLE_DATE,
  '2020-07-01',
];

/**
 * 자본변동 게이트(Task 6)용 커버리지 연도. 이 파일의 제출 기간이 걸치는
 * 연도를 전부 담는다 — 취소 시퀀스 테스트가 2046 년까지 쓴다.
 */
const ACTION_COVERAGE_YEARS = yearRange(2020, 2046);

/** 유니버스 규칙 — MARKET_CAP 단계 limit=1 이면 005930만, 2면 000660도 함께 들어온다 */
function universeRule(topN = 1): BacktestRequest['universeRule'] {
  return {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: topN }],
    rebalanceInterval: { value: 1, unit: 'MONTH' },
  };
}

/** 이 파일이 공유하는 종목 마스터 픽스처 — 005930 시총 1위, 000660 2위 */
function seedMaster(container: TestApp['container'], dates: readonly string[]): void {
  seedSymbolMasterUniverse(container, dates, [
    { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSPI', marketCapKrw: '1000000000000' },
  ]);
}

/**
 * 평일 일봉. 상승(돌파 진입) → 급락(손절 청산) → 재상승(재진입) 국면으로
 * 완결 거래가 반드시 둘 이상 생기도록 구성한다.
 */
function buildTrendingDailyCandles(symbol = '005930', days = 43): Candle[] {
  const candles: Candle[] = [];
  let tradingDays = 0;
  let dayCursor = Date.UTC(2026, 0, 5); // 2026-01-05 (월)

  const baseForDay = (day: number): number => {
    if (day < 15) return 100 + day * 5; // 상승: 100 → 170
    if (day < 23) return 170 - (day - 14) * 6; // 급락: 170 → 122
    return 122 + (day - 22) * 5; // 재상승
  };

  while (tradingDays < days) {
    const dayOfWeek = new Date(dayCursor).getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const base = baseForDay(tradingDays);
      const open = base;
      const close = base + 2;
      candles.push({
        symbol,
        market: 'KR',
        timeframe: '1d',
        tsMs: dayCursor,
        open,
        high: close + 1,
        low: open - 1,
        close,
        volume: 1_000,
      });
      tradingDays += 1;
    }
    dayCursor += DAY;
  }
  return candles;
}

function buildRequest(): BacktestRequest {
  return {
    strategyId: STRATEGY_ID,
    parameters: {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      riskPerTradePercent: 2,
    },
    universeRule: universeRule(1),
    period: { from: '2026-01-05', to: '2026-06-30' },
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

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('backtest job queue (스펙 §10, §14)', () => {
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
    // 20년 월별 유니버스를 준비하는 취소 테스트도 포함한다. full suite의 병렬 부하에서
    // 준비만 5초를 넘을 수 있으므로 이 파일의 fixture 준비 예산만 현실화한다.
    installPreparedSubmissionFixture(ctx, { preparationTimeoutMs: 15_000 });

    registerSymbols(ctx.container, 'KR', ['005930']);
    dailyCandles = buildTrendingDailyCandles();
    seedDailyBars(ctx.container.database.db, dailyCandles);
    // 종목 마스터 — 유니버스 규칙(스펙 2026-08-05)이 여기서 종목을 골라낸다
    seedMaster(ctx.container, REBALANCE_DATES);
    // 자본변동 게이트(Task 6) — 수집을 마쳤다고 표시해야 제출이 통과한다
    await seedCorporateActionCoverage(ctx.container, ['005930'], ACTION_COVERAGE_YEARS);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('상세 조회는 멤버 원문 대신 최초 구성과 편입·편출 요약을 반환한다', async () => {
    const job = ctx.container.jobQueue.enqueue(buildRequest(), [
      {
        rebalanceDate: '2026-01-05',
        effectiveTradingDate: '2026-01-02',
        symbols: ['005930', '000660'],
        excludedNonTradingCount: 0,
      },
      {
        rebalanceDate: '2026-02-05',
        effectiveTradingDate: '2026-02-05',
        symbols: ['000660', '035420', '051910'],
        excludedNonTradingCount: 0,
      },
    ]);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}`,
      cookies: { qp_session: cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.universeRebalancing).toEqual([
      {
        kind: 'INITIAL',
        rebalanceDate: '2026-01-05',
        effectiveDate: '2026-01-02',
        memberCount: 2,
      },
      {
        kind: 'CHANGE',
        rebalanceDate: '2026-02-05',
        effectiveDate: '2026-02-05',
        addedCount: 2,
        removedCount: 1,
        changedCount: 3,
      },
    ]);
    expect(body.job).not.toHaveProperty('universeScheduleJson');
  });

  it('저장된 멤버십 일정 JSON이 손상돼도 상세 조회와 나머지 결과는 유지한다', async () => {
    const job = ctx.container.jobQueue.enqueue(buildRequest());
    ctx.container.database.db
      .update(backtestJobs)
      .set({ universeScheduleJson: '{' })
      .where(eq(backtestJobs.id, job.id))
      .run();

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}`,
      cookies: { qp_session: cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().job.id).toBe(job.id);
    expect(response.json().universeRebalancing).toEqual([]);
  });

  it('runs a backtest end-to-end in a child process', { timeout: 90_000 }, async () => {
    // 성공 경로는 요청 종료일까지 가격 봉이 완전해야 한다. 이전 43봉 픽스처는
    // 3월 초에 끝나면서도 6월 말 결과를 정상 완료해 B-001을 재현하고 있었다.
    dailyCandles = buildTrendingDailyCandles('005930', 127);
    seedDailyBars(ctx.container.database.db, dailyCandles);

    // 제출 시점 pin 이 실제 재무 버전 상태를 반영하는지 검증하려면 버전이 하나는
    // 있어야 한다 — facts 동기화가 실제로 한 번 있었다고 가정한다.
    ctx.container.symbolService.bumpVersion('005930', FACTS_SLICE, 'fact-sync:seed', Date.now());

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string; status: string }).id;
    expect(created.json().job.status).toBe('QUEUED');

    // 오케스트레이터 수동 tick → 자식 프로세스 실행
    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');

    // 실행 단계 계측은 child IPC를 거쳐 부모의 종료 감사 기록에 합쳐진다. 작업 상태가
    // 먼저 COMPLETED가 될 수 있으므로 audit 행이 생길 때까지 별도로 기다린다.
    const finishedDetail = (): {
      executionTelemetry?: {
        outcome: string;
        failedStage: string | null;
        peakRssBytes: number;
        durationsMs: { load: number; run: number; persist: number; total: number };
        input: { candleCount: number; factCount: number; symbolCount: number } | null;
        output: { rowCount: number; tradeCount: number } | null;
      };
    } | undefined => (
      ctx.container.database.sqlite
        .prepare("SELECT detail_json FROM audit_logs WHERE event = 'backtest.finished'")
        .all() as Array<{ detail_json: string }>
    )
      .map((row) => JSON.parse(row.detail_json) as {
        jobId: string;
        executionTelemetry?: {
          outcome: string;
          failedStage: string | null;
          peakRssBytes: number;
          durationsMs: { load: number; run: number; persist: number; total: number };
          input: { candleCount: number; factCount: number; symbolCount: number } | null;
          output: { rowCount: number; tradeCount: number } | null;
        };
      })
      .find((detail) => detail.jobId === jobId);
    await waitFor(() => finishedDetail()?.executionTelemetry !== undefined, 15_000);
    expect(finishedDetail()?.executionTelemetry).toMatchObject({
      outcome: 'COMPLETED',
      failedStage: null,
      peakRssBytes: expect.any(Number),
      durationsMs: {
        load: expect.any(Number),
        run: expect.any(Number),
        persist: expect.any(Number),
        total: expect.any(Number),
      },
      input: {
        candleCount: dailyCandles.length,
        symbolCount: 1,
      },
      output: {
        tradeCount: expect.any(Number),
        rowCount: expect.any(Number),
      },
    });
    expect(finishedDetail()!.executionTelemetry!.peakRssBytes).toBeGreaterThan(0);
    expect(finishedDetail()!.executionTelemetry!.output!.rowCount).toBeGreaterThan(0);

    // 상세 조회: 재현성 메타데이터 + 지표 (스펙 §9.5, §9.6)
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}`,
      cookies: { qp_session: cookie },
    });
    const body = detail.json() as {
      run: Record<string, unknown>;
      metrics: Record<string, unknown>;
    };
    expect(body.run.engineVersion).toBe(ENGINE_VERSION);
    expect(body.run.strategyId).toBe('range-breakout');
    expect(body.run.feeModelVersion).toBe('kr-equity-default@2.1.0');
    expect(body.run.randomSeed).toBe(42);
    expect(body.run.universeHash).not.toBe('unknown');
    // 제출 시점에 고정된 종목 버전 스냅샷이 그대로 기록돼야 한다 (재현성 §9.5).
    // 버전 축은 이제 재무(FACTS_SLICE) 하나뿐이다 — getLatestVersion 이 private 이라
    // symbol_versions 테이블을 직접 조회해 대조한다.
    const pinned = ctx.container.database.db
      .select()
      .from(symbolVersions)
      .where(and(eq(symbolVersions.code, '005930'), eq(symbolVersions.slice, FACTS_SLICE)))
      .orderBy(desc(symbolVersions.version))
      .limit(1)
      .get()!;
    const universeJson = JSON.parse(body.run.universeJson as string) as Array<{
      code: string;
      slice: string;
      version: number;
      contentHash: string;
    }>;
    const pinnedEntry = universeJson.find((e) => e.code === '005930' && e.slice === FACTS_SLICE)!;
    expect(pinnedEntry.version).toBe(pinned.version);
    expect(pinnedEntry.contentHash).toBe(pinned.contentHash);
    expect(typeof body.metrics.totalReturnPct).toBe('number');
    expect(body.metrics.tradeCount as number).toBeGreaterThan(0);

    // 거래 내역
    const trades = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}/trades`,
      cookies: { qp_session: cookie },
    });
    expect((trades.json().trades as unknown[]).length).toBeGreaterThan(0);
    // 페이지네이션 UI 가 {현재}/{전체} 페이지를 계산하려면 필터 기준 총 건수가 필요하다
    expect(trades.json().total).toBe(body.metrics.tradeCount);
    // 정렬 파라미터가 없으면 매도 체결 시각 오름차순이다 — 예전 순서가 그대로여야 한다
    const defaultOrder = trades.json().trades as Array<{ exitTsMs: number }>;
    expect(defaultOrder.map((t) => t.exitTsMs)).toEqual(
      [...defaultOrder.map((t) => t.exitTsMs)].sort((a, b) => a - b),
    );

    // 거래 내역 정렬 — 정렬은 서버가 한다 (화면에서 하면 한 페이지만 뒤집힌다)
    const fetchTrades = async (query: string) => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/backtests/${jobId}/trades?${query}`,
        cookies: { qp_session: cookie },
      });
      return response;
    };

    const byPnlDesc = await fetchTrades('sort=NET_PNL&dir=DESC&limit=500');
    const pnls = (byPnlDesc.json().trades as Array<{ netPnl: number }>).map((t) => t.netPnl);
    expect(pnls.length).toBeGreaterThan(1);
    expect(pnls).toEqual([...pnls].sort((a, b) => b - a));

    const byPnlAsc = await fetchTrades('sort=NET_PNL&dir=ASC&limit=500');
    expect((byPnlAsc.json().trades as Array<{ netPnl: number }>).map((t) => t.netPnl)).toEqual(
      [...pnls].reverse(),
    );

    // 보유기간은 동률이 흔하다 — 동률 순서가 정해지지 않으면 페이지 경계에서 같은
    // 거래가 두 번 나오거나 빠진다. 페이지를 이어 붙인 것이 한 번에 받은 것과 같아야 한다
    const whole = await fetchTrades('sort=HOLDING_TIME&dir=DESC&limit=500');
    const wholeIds = (whole.json().trades as Array<{ id: number }>).map((t) => t.id);
    const paged: number[] = [];
    for (let offset = 0; offset < wholeIds.length; offset += 2) {
      const page = await fetchTrades(`sort=HOLDING_TIME&dir=DESC&limit=2&offset=${offset}`);
      paged.push(...(page.json().trades as Array<{ id: number }>).map((t) => t.id));
    }
    expect(paged).toEqual(wholeIds);
    expect(new Set(paged).size).toBe(paged.length);

    // 모르는 축은 400 이다 — 조용히 기본 정렬로 떨어지면 화면 표기와 실제가 어긋난다
    const badSort = await fetchTrades('sort=NOPE');
    expect(badSort.statusCode).toBe(400);
    const badDir = await fetchTrades('sort=NET_PNL&dir=UP');
    expect(badDir.statusCode).toBe(400);

    // 차트 시리즈 (다운샘플)
    const series = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}/series`,
      cookies: { qp_session: cookie },
    });
    const seriesBody = series.json() as {
      equity: unknown[];
      drawdown: unknown[];
      totalEquityPoints: number;
    };
    expect(seriesBody.equity.length).toBeGreaterThan(0);
    expect(seriesBody.equity.length).toBeLessThanOrEqual(1_000);
    // 완전한 성공 픽스처의 마지막 실제 봉이 요청 종료일이므로 terminal anchor는
    // 같은 점을 재사용한다. 데이터가 일찍 끊긴 상태로 +1점을 만드는 경로가 아니다.
    expect(seriesBody.totalEquityPoints).toBe(dailyCandles.length);

    // SSE: 종료 상태 작업은 스냅샷 1건 후 종료
    const events = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}/events`,
      cookies: { qp_session: cookie },
    });
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.payload).toContain('"status":"COMPLETED"');

    // export
    const exported = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}/export`,
      cookies: { qp_session: cookie },
    });
    expect(exported.headers['content-disposition']).toContain('attachment');
    const exportedEquity = (exported.json() as {
      equityPoints: Array<{ tsMs: number }>;
    }).equityPoints;
    expect(exportedEquity).toHaveLength(dailyCandles.length);
    expect(exportedEquity.at(-1)?.tsMs).toBe(Date.parse('2026-06-30T00:00:00Z'));

    // clone → 새 QUEUED 작업
    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${jobId}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(201);
    expect(cloned.json().job.status).toBe('QUEUED');
  });

  it('제출 뒤 SCD identity가 바뀐 QUEUED 작업은 child가 결과 생성 전에 실패시킨다', {
    timeout: 30_000,
  }, async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().job.id as string;

    ctx.container.database.db.insert(symbolMasterVersions).values({
      standardCode: 'KR7999999999',
      shortCode: '005930',
      validFromDate: '1990-01-01',
      validToDate: '2000-01-01',
      name: '과거 발행사',
      market: 'KOSPI',
      sharesOutstanding: '1',
      instrumentType: 'COMMON_STOCK',
      listedDate: '1990-01-01',
      recordedAtMs: ctx.container.clock.now(),
    }).run();

    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 20_000);

    expect(ctx.container.jobQueue.getJob(jobId)).toMatchObject({
      status: 'FAILED',
      error: expect.stringMatching(/단축코드 005930.*여러 표준코드/),
    });
    expect(ctx.container.resultsService.getTotalReturnPct(jobId)).toBeNull();
  });

  it('요청한 부분 유니버스 종목만 제출 시점 버전으로 pin 한다', async () => {
    // 000660 이 시총 2위라 topN=1(기본값) 이면 유니버스에서 자연히 빠진다 —
    // 유니버스 후보 중 일부만 실제 실행에 소비되는 상황을 만든다.
    ctx.container.symbolService.addSymbol('000660', 'KR', 'SK하이닉스');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });

    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;
    const job = ctx.container.jobQueue.getJob(jobId)!;
    const pinned = JSON.parse(job.universeJson!) as Array<{ code: string }>;
    expect([...new Set(pinned.map(({ code }) => code))]).toEqual(['005930']);
  });

  it('요청 interval의 DAY 일정으로 유니버스를 해소해 job에 고정한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        ...buildRequest(),
        period: { from: MAIN_DATE, to: '2026-01-07' },
        universeRule: {
          markets: ['KOSPI'],
          stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
          rebalanceInterval: { value: 1, unit: 'DAY' },
        },
      },
    });

    expect(created.statusCode).toBe(201);
    const jobId = (created.json() as { job: { id: string } }).job.id;
    const schedule = JSON.parse(ctx.container.jobQueue.getJob(jobId)!.universeScheduleJson) as Array<{
      rebalanceDate: string;
    }>;
    expect(schedule.map((entry) => entry.rebalanceDate)).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
    ]);
  });

  it('2봉 랭킹 전략은 연속 실제 거래 봉 리밸런스를 enqueue 전에 거부한다', async () => {
    await seedValueQualityFacts(ctx.container, ['005930']);
    seedFinancialCoverage(ctx.container, ['005930'], [2025, 2026]);
    const before = ctx.container.jobQueue.countByStatus([
      'QUEUED', 'STARTING', 'RUNNING', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED',
    ]);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        ...buildRequest(),
        strategyId: 'value-quality-rank',
        parameters: { topN: 1, staleQuarters: 2 },
        period: { from: MAIN_DATE, to: '2026-01-07' },
        universeRule: {
          markets: ['KOSPI'],
          stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
          rebalanceInterval: { value: 1, unit: 'DAY' },
        },
      },
    });

    expect(created.statusCode).toBe(422);
    expect((created.json() as { error: string }).error).toMatch(
      /밸류·퀄리티 랭킹.*연속 리밸런스.*2026-01-05.*2026-01-06.*최소 1개 필요/,
    );
    expect(ctx.container.jobQueue.countByStatus([
      'QUEUED', 'STARTING', 'RUNNING', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED',
    ])).toBe(before);
  });

  it('claims jobs atomically in FIFO order', () => {
    const queue = ctx.container.jobQueue;
    const first = queue.enqueue(buildRequest());
    const second = queue.enqueue(buildRequest());

    const claimA = queue.claimNext('w1');
    const claimB = queue.claimNext('w2');
    const claimC = queue.claimNext('w3');

    expect(claimA?.id).toBe(first.id);
    expect(claimB?.id).toBe(second.id);
    expect(claimC).toBeNull();
    expect(claimA?.status).toBe('STARTING');
  });

  it(
    'cancels an active job through the child process (스펙 §10 취소 시퀀스)',
    { timeout: 60_000 },
    async () => {
      // 기본 픽스처(43봉)는 CANCEL_YIELD_INTERVAL_BARS(200봉)에 못 미쳐 양보가
      // 한 번도 안 걸린다. 양보 창을 여러 번 확보하도록 훨씬 긴 봉을 따로 심는다.
      seedDailyBars(ctx.container.database.db, buildTrendingDailyCandles('005930', 5_000));

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: { ...buildRequest(), period: { from: '2026-01-05', to: '2046-01-05' } },
      });
      const jobId = (created.json().job as { id: string }).id;

      // STARTING 취소는 자식 모듈 초기화와 문서화된 5초 escalation grace period가 경합한다.
      // 따라서 통합 계약은 설정된 어느 취소 경로든 허용한다.
      // IPC 리스너가 플래그를 세팅한다는 사실은 worker-cancellation.test.ts 가 증명한다.
      // 그 플래그가 실행 도중 실제로 관찰된다는 사실(D-042)은 engine.test.ts 의
      // runBacktestCancellable 취소 테스트가 증명한다.
      ctx.container.jobOrchestrator.tick();
      const cancelled = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${jobId}/cancel`,
        cookies: { qp_session: cookie },
      });
      expect(cancelled.json().status).toBe('CANCELLING');
      expect(ctx.container.jobQueue.getJob(jobId)!.status).toBe('CANCELLING');

      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 45_000);

      const final = ctx.container.jobQueue.getJob(jobId)!;
      expect(final.status).toBe('CANCELLED');
      expect(final.error).toBeNull();

      // SIGTERM·SIGKILL 폴백도 결국 CANCELLED 로 끝나므로 상태만으로는 세 경로가
      // 구분되지 않는다. 어느 단계가 프로세스를 끝냈는지는 감사 기록이 답한다 —
      // 예전에는 "SIGTERM 폴백 시각(5초) 전에 끝났으니 IPC 였을 것" 이라고 벽시계로
      // 추론했는데, 그 5초에 자식 부팅 시간이 통째로 들어가 부하가 걸린 머신에서
      // 배포 게이트를 막았다 (제품은 멀쩡했다).
      //
      // 기록이 나타날 때까지 기다린다: 자식은 최종 상태를 DB 에 먼저 쓰고 그 다음에
      // 종료하므로, CANCELLED 를 봤다고 부모의 exit 핸들러(=이 기록을 쓰는 곳)가
      // 이미 돌았다는 보장은 없다.
      const finishedDetail = (): { cancelPath?: string } | undefined =>
        (
          ctx.container.database.sqlite
            .prepare("SELECT detail_json FROM audit_logs WHERE event = 'backtest.finished'")
            .all() as Array<{ detail_json: string }>
        )
          .map((row) => JSON.parse(row.detail_json) as { jobId: string; cancelPath?: string })
          .find((d) => d.jobId === jobId);

      await waitFor(() => finishedDetail() !== undefined, 15_000);
      expect(['IPC', 'SIGTERM', 'SIGKILL']).toContain(finishedDetail()?.cancelPath);
    },
  );

  it('cancels a QUEUED job immediately', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${jobId}/cancel`,
      cookies: { qp_session: cookie },
    });
    expect(cancelled.json().status).toBe('CANCELLED');
    expect(ctx.container.jobQueue.getJob(jobId)!.status).toBe('CANCELLED');
  });

  it('제출 경고를 job 에 저장한다 — 토스트 10초 뒤에도 남아야 한다', () => {
    const job = ctx.container.jobQueue.enqueue(buildRequest(), [], undefined, null, [
      '005930 자본변동 이력에 gap 이 있습니다',
    ]);

    const stored = ctx.container.jobQueue.getJob(job.id)!;
    expect(JSON.parse(stored.submitWarningsJson!)).toEqual([
      '005930 자본변동 이력에 gap 이 있습니다',
    ]);
  });

  it('never regresses a terminal status via late progress or status writes (C1)', () => {
    const queue = ctx.container.jobQueue;
    const job = queue.enqueue(buildRequest());
    queue.claimNext('w1'); // QUEUED → STARTING
    queue.markRunning(job.id); // STARTING → RUNNING
    expect(queue.getJob(job.id)!.status).toBe('RUNNING');

    // 자식이 COMPLETED 를 기록한 뒤 늦게 도착한 진행률·전이 시도들
    queue.setStatus(job.id, 'COMPLETED');
    queue.updateProgress(job.id, 999, 999, 'late');
    queue.markRunning(job.id);
    expect(queue.setStatus(job.id, 'FAILED', {}, ['STARTING', 'RUNNING'])).toBe(false);

    const final = queue.getJob(job.id)!;
    expect(final.status).toBe('COMPLETED');
    expect(final.progressBars).not.toBe(999); // 종료 후 진행률도 동결
  });

  it('does not let progress writes disturb CANCELLING (C1)', () => {
    const queue = ctx.container.jobQueue;
    const job = queue.enqueue(buildRequest());
    queue.claimNext('w1');
    queue.markRunning(job.id);
    queue.setStatus(job.id, 'CANCELLING', {}, ['RUNNING', 'STARTING']);

    queue.updateProgress(job.id, 50, 100, 'mid'); // 취소 중 진행률은 상태를 못 바꾼다
    queue.markRunning(job.id);
    expect(queue.getJob(job.id)!.status).toBe('CANCELLING');
    // 진행률 자체는 활성 상태라 반영된다
    expect(queue.getJob(job.id)!.progressBars).toBe(50);
  });

  it('recovers orphaned active jobs as INTERRUPTED on restart (스펙 §10)', () => {
    const queue = ctx.container.jobQueue;
    const job = queue.enqueue(buildRequest());
    queue.setStatus(job.id, 'RUNNING', { pid: 999_999_999 });

    const recovered = queue.recoverInterrupted(() => false);
    expect(recovered).toContain(job.id);
    expect(queue.getJob(job.id)!.status).toBe('INTERRUPTED');
    expect(queue.getJob(job.id)!.error).toContain('복제');
  });

  it('preserves live remote leases on remote restart and interrupts them on local mode switch', () => {
    const queue = ctx.container.jobQueue;
    const job = queue.enqueue(buildRequest());
    queue.claimNextRemote({
      workerId: 'remote:worker-a',
      leaseTokenHash: 'a'.repeat(64),
      leaseExpiresAtMs: Date.now() + 60_000,
      runnerVersion: 'release-a',
      maxAttempts: 3,
    });

    expect(queue.recoverInterrupted(() => false)).not.toContain(job.id);
    expect(queue.getJob(job.id)?.status).toBe('STARTING');
    expect(queue.interruptActiveRemoteLeases()).toContain(job.id);
    expect(queue.getJob(job.id)).toMatchObject({
      status: 'INTERRUPTED',
      leaseTokenHash: null,
      leaseExpiresAtMs: null,
    });
  });

  it('refuses to delete non-terminal jobs', async () => {
    const queue = ctx.container.jobQueue;
    const job = queue.enqueue(buildRequest());

    const denied = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/backtests/${job.id}`,
      cookies: { qp_session: cookie },
    });
    expect(denied.statusCode).toBe(409);

    queue.setStatus(job.id, 'CANCELLED');
    const allowed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/backtests/${job.id}`,
      cookies: { qp_session: cookie },
    });
    expect(allowed.statusCode).toBe(204);
  });

  it('rejects requests referencing unknown entities', async () => {
    const badStrategy = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(), strategyId: 'nope' },
    });
    expect(badStrategy.statusCode).toBe(400);

    // 종목 마스터가 커버하지 않는 날짜는 Task 6부터 제출 검증 전에 durable
    // preparation으로 해소한다. KRX를 준비하지 않은 이 fixture에서는 409가 계약이다.
    const badUniverseDate = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(), period: { from: '1999-01-01', to: '1999-06-30' } },
    });
    expect(badUniverseDate.statusCode).toBe(409);
    expect((badUniverseDate.json() as { error: string }).error).toBe('PREPARATION_REQUIRED');

    const badParams = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        ...buildRequest(),
        parameters: { lookbackBars: 9_999 },
      },
    });
    expect(badParams.statusCode).toBe(400);
  });

  it('준비 완료 뒤 발견된 종목 identity 오류를 신규 제출과 복제에서 422로 반환한다', async () => {
    const source = ctx.container.jobQueue.enqueue(buildRequest());
    ctx.container.backtestPreparationOrchestrator.getReadyPreview = async () => {
      throw new UnsafeBacktestSymbolIdentityError('기존 등록 종목의 표준코드가 선택된 증권과 다릅니다.');
    };

    const submitted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(submitted.statusCode).toBe(422);
    expect((submitted.json() as { error: string }).error).toContain('표준코드');

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${source.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(422);
    expect((cloned.json() as { error: string }).error).toContain('표준코드');
  });

  it('준비 완료 뒤 등록 identity가 사라지면 모든 실행 생성 경로를 422로 차단한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;

    ctx.container.database.db
      .update(symbols)
      .set({ standardCode: null })
      .where(eq(symbols.code, '005930'))
      .run();

    const attempts = [
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: buildRequest(),
      }),
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${sourceId}/clone`,
        cookies: { qp_session: cookie },
      }),
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${sourceId}/clone-configured`,
        cookies: { qp_session: cookie },
        payload: buildRequest(),
      }),
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
        cookies: { qp_session: cookie },
        payload: { count: 2 },
      }),
    ];

    for (const response of attempts) {
      expect(response.statusCode).toBe(422);
      expect((response.json() as { error: string }).error).toContain('표준코드');
    }
  });

  it('전체 SCD에서 단축코드 재사용이 발견되면 캐시·복제 실행 경로를 모두 차단한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;

    // 현재 일정과 겹치지 않는 과거 행이어도 shortCode 기반 봉·팩트에는 발행사 구분이
    // 없으므로 전체 생애 충돌이다.
    ctx.container.database.db.insert(symbolMasterVersions).values({
      standardCode: 'KR7999999999',
      shortCode: '005930',
      validFromDate: '1990-01-01',
      validToDate: '2000-01-01',
      name: '과거 발행사',
      market: 'KOSPI',
      sharesOutstanding: '1',
      instrumentType: 'COMMON_STOCK',
      listedDate: '1990-01-01',
      recordedAtMs: ctx.container.clock.now(),
    }).run();

    const beforeJobs = ctx.container.jobQueue.listJobs(500, 0).length;
    const beforeBatches = ctx.container.seedCloneBatchService.list().length;
    const attempts = [
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: buildRequest(),
      }),
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${sourceId}/clone`,
        cookies: { qp_session: cookie },
      }),
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${sourceId}/clone-configured`,
        cookies: { qp_session: cookie },
        payload: buildRequest(),
      }),
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
        cookies: { qp_session: cookie },
        payload: { count: 2 },
      }),
    ];

    for (const response of attempts) {
      expect(response.statusCode).toBe(422);
      expect((response.json() as { error: string }).error)
        .toMatch(/단축코드 005930.*여러 표준코드/);
    }
    expect(ctx.container.jobQueue.listJobs(500, 0)).toHaveLength(beforeJobs);
    expect(ctx.container.seedCloneBatchService.list()).toHaveLength(beforeBatches);

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${sourceId}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().reusablePreview).toBeNull();
    expect(draft.json().blockers[0]).toMatch(/단축코드 005930.*여러 표준코드/);
  });

  it('reports schema violations in Korean, not raw Zod English (M9 마무리)', async () => {
    const badBody = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(), capital: { initialCash: -1, currency: 'KRW' } },
    });
    expect(badBody.statusCode).toBe(400);
    const message = (badBody.json() as { error: string }).error;
    expect(message).toMatch(/[가-힣]/);
    expect(message).not.toMatch(/Too small|Invalid|expected/i);
  });

  it('기간에 봉이 전혀 없는 종목은 준비에서 제외하고 대체 후보가 없으면 완료하지 않는다', async () => {
    // 종목 마스터는 이 날짜를 커버하지만(coverage 는 넓은 고정 구간) 가격 데이터는
    // 2026-01-05 부터다 — 그보다 훨씬 앞선 구간은 확실히 0봉이다
    const noData = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(), period: { from: NO_CANDLE_DATE, to: '2020-12-31' } },
    });
    expect(noData.statusCode).toBe(409);
    expect((noData.json() as { error: string }).error).toBe('PREPARATION_REQUIRED');
  });

  it('리밸런스 적용에 필요한 최소 구간만 커버되면 기간 중 상장 상태를 모르므로 제출을 거부한다', async () => {
    const request = buildRequest();
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

    // 준비 뒤 전체 coverage를 리밸런스별 '적용 거래일~요청일' 섬으로 바꾼다.
    // 휴일 리밸런스는 직전 거래일까지 같은 커버 구간에 있어야 resolver가 일정을
    // 다시 만들 수 있다. 이 최소 섬들 사이 평일은 여전히 비므로 periodCovered=false다.
    const rebalanceDates = [
      '2026-01-05',
      '2026-02-05',
      '2026-03-05',
      '2026-04-05',
      '2026-05-05',
      '2026-06-05',
    ];
    const isolatedCoverage = rebalanceDates.map((date) => ({
      startDate: ctx.container.symbolMasterService.effectiveTradingDateWithinCoverage(date)!,
      endDate: date,
      syncedAtMs: ctx.container.clock.now(),
    }));
    ctx.container.database.db.delete(symbolMasterCoverage).run();
    ctx.container.database.db.insert(symbolMasterCoverage).values(isolatedCoverage).run();

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: request,
    });

    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: string }).error).toContain('기간 전체');
  });

  it('제출 뒤 종목 마스터 기간 coverage가 사라져도 worker가 실행 전에 중단한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    ctx.container.database.db.delete(symbolMasterCoverage).run();
    ctx.container.database.db.insert(symbolMasterCoverage).values(
      ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05']
        .map((date) => ({
          startDate: date,
          endDate: date,
          syncedAtMs: ctx.container.clock.now(),
        })),
    ).run();

    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.status).toBe('FAILED');
    expect(job.error).toContain('기간 전체');
    expect(ctx.container.resultsService.getRun(jobId)).toBeNull();
  });

  it('복제 준비도 봉 없는 종목을 제외한다 — 대체 후보까지 없으면 준비가 필요하다', async () => {
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(),
      period: { from: NO_CANDLE_DATE, to: '2020-12-31' },
    });

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(409);
    expect((cloned.json() as { error: string }).error).toBe('PREPARATION_REQUIRED');
  });

  it('복제 준비도 재무가 없는 종목을 제외한다 — 대체 후보까지 없으면 준비가 필요하다', async () => {
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(),
      strategyId: 'value-quality-rank',
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
    });

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(409);
    expect((cloned.json() as { error: string }).error).toBe('PREPARATION_REQUIRED');
  });

  it.each([
    'new',
    'clone',
    'clone-configured',
    'clone-random-seeds',
  ] as const)('$case 경로는 준비 확인 직후 재무 coverage가 사라져도 생성하지 않는다', async (route) => {
    const valueRequest: BacktestRequest = {
      ...buildRequest(),
      strategyId: 'value-quality-rank',
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
      risk: { maxPositions: 1 },
    };
    await seedValueQualityFacts(ctx.container, ['005930']);
    seedFinancialCoverage(ctx.container, ['005930'], [2025, 2026]);
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: valueRequest,
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;
    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    const cached = ctx.container.backtestPreparationOrchestrator.getCachedPreview({
      universeRule: valueRequest.universeRule,
      period: valueRequest.period,
      strategyId: valueRequest.strategyId,
      parameters: valueRequest.parameters,
    });
    expect(cached).not.toBeNull();

    ctx.container.database.db.update(symbolFactsState)
      .set({ coveredYearsJson: JSON.stringify([2026]) })
      .where(eq(symbolFactsState.code, '005930'))
      .run();
    // 완료 cache 검사와 각 생성 관문의 TOCTOU를 강제로 연다. enqueue 직전 공통
    // predicate가 다시 잡아야 하며, job/batch 행은 하나도 늘면 안 된다.
    if (route === 'new') {
      ctx.container.backtestPreparationOrchestrator.getReadyPreview = async () => cached;
    } else {
      ctx.container.backtestPreparationOrchestrator.getCachedPreview = () => cached;
    }
    if (route === 'new' || route === 'clone') {
      // 공용 테스트 fixture가 409를 받으면 preparation을 자동 실행한다. 이 race에서는
      // 결측을 다시 채우지 않아 최초 409 응답 자체와 job 불변을 관찰한다.
      ctx.container.factSyncService.sync = async () => ({
        savedFacts: 0,
        gaps: [],
        stoppedAtSymbol: null,
        stopReason: null,
        failureMessage: null,
      });
    }
    const beforeJobs = ctx.container.jobQueue.listJobs(500, 0).length;
    const beforeBatches = ctx.container.seedCloneBatchService.list().length;
    const url = route === 'new'
      ? '/api/v1/backtests'
      : `/api/v1/backtests/${sourceId}/${route}`;
    const payload = route === 'new'
      ? { ...valueRequest, randomSeed: 99 }
      : route === 'clone-configured'
        ? { ...valueRequest, randomSeed: 99 }
        : route === 'clone-random-seeds'
          ? { count: 2 }
          : undefined;
    const rejected = await ctx.app.inject({
      method: 'POST',
      url,
      cookies: { qp_session: cookie },
      ...(payload === undefined ? {} : { payload }),
    });

    expect(rejected.statusCode).toBe(409);
    expect((rejected.json() as { error: string }).error).toBe('PREPARATION_REQUIRED');
    expect((rejected.json() as { message: string }).message).toMatch(/coverage.*2025~2026년.*005930/);
    expect(ctx.container.jobQueue.listJobs(500, 0)).toHaveLength(beforeJobs);
    expect(ctx.container.seedCloneBatchService.list()).toHaveLength(beforeBatches);
  });

  it.each([
    'new',
    'clone',
    'clone-configured',
    'clone-random-seeds',
  ] as const)('%s 경로는 검증 직후 실행 봉이 사라지면 500 대신 재준비 409를 반환한다', async (route) => {
    const valueRequest: BacktestRequest = {
      ...buildRequest(),
      strategyId: 'value-quality-rank',
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
      risk: { maxPositions: 1 },
    };
    await seedValueQualityFacts(ctx.container, ['005930']);
    seedFinancialCoverage(ctx.container, ['005930'], [2025, 2026]);
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: valueRequest,
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;
    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);

    const cached = ctx.container.backtestPreparationOrchestrator.getCachedPreview({
      universeRule: valueRequest.universeRule,
      period: valueRequest.period,
      strategyId: valueRequest.strategyId,
      parameters: valueRequest.parameters,
    });
    expect(cached).not.toBeNull();
    if (route === 'new' || route === 'clone') {
      // 자동 준비 fixture가 첫 409를 숨겨 두 번째 요청의 400으로 바꾸지 않게 하고,
      // 현재 preview 재계산보다 뒤인 validateSubmission 경계에서만 봉을 지운다.
      vi.spyOn(ctx.container.backtestPreparationOrchestrator, 'getReadyPreview')
        .mockResolvedValue(cached);
      const failedPreparation = {
        id: 'prep_forced_failed',
        requestHash: 'forced',
        status: 'FAILED' as const,
        phase: 'MARKET_DATA' as const,
        doneSymbols: 0,
        totalSymbols: 0,
        savedFacts: 0,
        gapCount: 0,
        nextResumeAtMs: null,
        error: 'forced test failure',
      };
      vi.spyOn(ctx.container.backtestPreparationOrchestrator, 'start')
        .mockReturnValue(failedPreparation);
      const getPreparation = ctx.container.backtestPreparationOrchestrator.get
        .bind(ctx.container.backtestPreparationOrchestrator);
      vi.spyOn(ctx.container.backtestPreparationOrchestrator, 'get')
        .mockImplementation((id) => id === failedPreparation.id
          ? failedPreparation
          : getPreparation(id));
    }

    const candleCoverage = ctx.container.candleCoverageService;
    const getCoverageBetween = candleCoverage.getCoverageBetween.bind(candleCoverage);
    vi.spyOn(candleCoverage, 'getCoverageBetween').mockImplementation((...args) => {
      const rows = getCoverageBetween(...args);
      ctx.container.database.db.delete(krxDailyBars)
        .where(and(
          eq(krxDailyBars.shortCode, '005930'),
          gte(krxDailyBars.date, valueRequest.period.from),
          lte(krxDailyBars.date, valueRequest.period.to),
        ))
        .run();
      return rows;
    });

    const beforeJobs = ctx.container.jobQueue.listJobs(500, 0).length;
    const beforeBatches = ctx.container.seedCloneBatchService.list().length;
    const url = route === 'new'
      ? '/api/v1/backtests'
      : `/api/v1/backtests/${sourceId}/${route}`;
    const payload = route === 'new'
      ? { ...valueRequest, randomSeed: 99 }
      : route === 'clone-configured'
        ? { ...valueRequest, randomSeed: 99 }
        : route === 'clone-random-seeds'
          ? { count: 2 }
          : undefined;
    const rejected = await ctx.app.inject({
      method: 'POST',
      url,
      cookies: { qp_session: cookie },
      ...(payload === undefined ? {} : { payload }),
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: 'PREPARATION_REQUIRED' });
    expect((rejected.json() as { message: string }).message).toContain('005930');
    expect(ctx.container.jobQueue.listJobs(500, 0)).toHaveLength(beforeJobs);
    expect(ctx.container.seedCloneBatchService.list()).toHaveLength(beforeBatches);
  });

  it('재설정 및 복제 초안은 유니버스 준비와 무관하게 저장 요청을 복원한다', async () => {
    const request = buildRequest();
    const job = ctx.container.jobQueue.enqueue(request);

    // 이 경계 아래는 전체 기간의 유니버스 해소와 coverage 검증이다. 초안 조회는 이
    // 작업이 불가능한 상태에서도 저장 요청과 재기준 경고를 돌려줘야 한다.
    ctx.container.backtestPreparationOrchestrator.getReadyPreview = async () => {
      throw new Error('clone-draft가 유니버스 준비를 호출했습니다');
    };

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });

    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toEqual({
      request,
      warnings: [],
      blockers: [],
      reusablePreview: null,
    });
  });

  it('제출된 원본은 저장 일정과 일치하는 준비 미리보기를 초안에서 재사용한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${sourceId}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const preview = draft.json().reusablePreview as {
      unionSymbols: string[];
      missingCandleSymbols: string[];
      uncoveredDates: string[];
    } | null;
    expect(preview).not.toBeNull();
    expect(preview?.unionSymbols).toEqual(['005930']);
    expect(preview?.missingCandleSymbols).toEqual([]);
    expect(preview?.uncoveredDates).toEqual([]);
  });

  it('복제 초안은 현재 PIT fact와 재무 coverage drift를 함께 반영한다', async () => {
    const request: BacktestRequest = {
      ...buildRequest(),
      strategyId: 'value-quality-rank',
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
      risk: { maxPositions: 1 },
    };
    await seedValueQualityFacts(ctx.container, ['005930']);
    seedFinancialCoverage(ctx.container, ['005930'], [2025, 2026]);

    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: request,
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;

    const before = await ctx.app.inject({
      method: 'GET', url: `/api/v1/backtests/${sourceId}/clone-draft`, cookies: { qp_session: cookie },
    });
    expect(before.json().reusablePreview.fundamentalSymbols).toEqual(['005930']);

    ctx.container.database.db.delete(facts)
      .where(eq(facts.key, '005930'))
      .run();
    await ctx.container.factRepository.saveFacts([{
      scope: 'SYMBOL', key: '005930', field: 'NET_INCOME', periodKey: '2026Q4',
      asOfTsMs: Date.parse('2027-01-01T00:00:00Z'), value: 2, unit: 'KRW',
    }]);
    seedFinancialCoverage(ctx.container, ['005930'], [2025, 2026]);
    const after = await ctx.app.inject({
      method: 'GET', url: `/api/v1/backtests/${sourceId}/clone-draft`, cookies: { qp_session: cookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().reusablePreview).toBeNull();

    ctx.container.database.db.update(symbolFactsState)
      .set({ coveredYearsJson: JSON.stringify([2026]) })
      .where(eq(symbolFactsState.code, '005930'))
      .run();
    const stale = await ctx.app.inject({
      method: 'GET', url: `/api/v1/backtests/${sourceId}/clone-draft`, cookies: { qp_session: cookie },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().reusablePreview).toBeNull();
  });

  it('복제 초안은 cached preview의 기간 coverage를 현재 상태로 다시 판정한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;

    ctx.container.database.db.delete(symbolMasterCoverage).run();
    ctx.container.database.db.insert(symbolMasterCoverage).values(
      ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05']
        .map((date) => ({
          startDate: date,
          endDate: date,
          syncedAtMs: ctx.container.clock.now(),
        })),
    ).run();

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${sourceId}/clone-draft`,
      cookies: { qp_session: cookie },
    });

    expect(draft.statusCode).toBe(200);
    expect(draft.json().reusablePreview).toMatchObject({
      periodCovered: false,
      uncoveredDates: [],
    });
  });

  it('복제 초안은 cached preview의 일봉 보유 상태를 현재 상태로 다시 판정한다', async () => {
    registerSymbols(ctx.container, 'KR', ['000660']);
    const periodCandles = buildTrendingDailyCandles('000660');
    seedDailyBars(ctx.container.database.db, [
      {
        symbol: '000660',
        market: 'KR',
        timeframe: '1d',
        tsMs: Date.parse('2025-12-31T00:00:00Z'),
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 1_000,
      },
      ...periodCandles,
    ]);
    await seedCorporateActionCoverage(ctx.container, ['000660'], ACTION_COVERAGE_YEARS);
    const request = { ...buildRequest(), universeRule: universeRule(2) };
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: request,
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;

    ctx.container.database.db
      .delete(krxDailyBars)
      .where(and(
        eq(krxDailyBars.shortCode, '000660'),
        gte(krxDailyBars.date, request.period.from),
        lte(krxDailyBars.date, request.period.to),
      ))
      .run();

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${sourceId}/clone-draft`,
      cookies: { qp_session: cookie },
    });

    expect(draft.statusCode).toBe(200);
    expect(draft.json().reusablePreview).toMatchObject({
      periodCovered: true,
      missingCandleSymbols: ['000660'],
    });

    // 같은 cached preview를 다시 읽더라도 현재 DB가 복구되면 결측도 사라져야 한다.
    seedDailyBars(ctx.container.database.db, periodCandles);
    const restoredDraft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${sourceId}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(restoredDraft.statusCode).toBe(200);
    expect(restoredDraft.json().reusablePreview).toMatchObject({
      periodCovered: true,
      missingCandleSymbols: [],
    });
  });

  it('재설정 복제는 준비 비영향 설정만 바뀌면 원본 유니버스를 재사용한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    const sourceId = created.json().job.id as string;
    const source = ctx.container.jobQueue.getJob(sourceId)!;
    const request = {
      ...buildRequest(),
      capital: { initialCash: 20_000_000, currency: 'KRW' as const },
      risk: { maxPositions: 10 },
      randomSeed: 777,
    };

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-configured`,
      cookies: { qp_session: cookie },
      payload: request,
    });
    expect(cloned.statusCode).toBe(201);
    const clonedRow = ctx.container.jobQueue.getJob(cloned.json().job.id as string)!;
    expect(JSON.parse(clonedRow.requestJson)).toMatchObject({
      capital: request.capital,
      risk: request.risk,
      randomSeed: 777,
    });
    expect(clonedRow.universeScheduleJson).toBe(source.universeScheduleJson);
    expect(clonedRow.universeJson).toBe(source.universeJson);

    const changedPeriod = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-configured`,
      cookies: { qp_session: cookie },
      payload: { ...request, period: { ...request.period, to: '2026-05-31' } },
    });
    expect(changedPeriod.statusCode).toBe(409);
    expect(changedPeriod.json().error).toBe('PREVIEW_REQUIRED');
  });

  it('원본 재현성 pin이 없거나 손상되면 미리보기와 새 난수 복제를 강제한다', async () => {
    const pinPatches: Array<Partial<typeof backtestJobs.$inferInsert>> = [
      { universeJson: null, universeHash: null },
      { provenancePinJson: '{손상된 JSON' },
      { benchmarkJson: '{}', benchmarkHash: '손상된 해시' },
    ];

    for (const patch of pinPatches) {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: buildRequest(),
      });
      expect(created.statusCode).toBe(201);
      const sourceId = created.json().job.id as string;
      expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
      ctx.container.database.db
        .update(backtestJobs)
        .set(patch)
        .where(eq(backtestJobs.id, sourceId))
        .run();

      const draft = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/backtests/${sourceId}/clone-draft`,
        cookies: { qp_session: cookie },
      });
      expect(draft.statusCode).toBe(200);
      expect(draft.json().reusablePreview).toBeNull();

      const randomSeeds = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
        cookies: { qp_session: cookie },
        payload: { count: 2 },
      });
      expect(randomSeeds.statusCode).toBe(409);
      expect(randomSeeds.json().error).toBe('PREVIEW_REQUIRED');
    }

    expect(ctx.container.seedCloneBatchService.list()).toEqual([]);
  });

  it('새 난수 100개는 중복 없이 저장하고 기존 QUEUED 상한만큼 순차 투입한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;
    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 100 },
    });
    expect(response.statusCode).toBe(201);
    const batchId = response.json().batch.id as string;
    expect(response.json().batch).toMatchObject({
      totalCount: 100,
      queuedCount: 20,
      pendingCount: 80,
    });
    expect(ctx.container.jobQueue.countByStatus(['QUEUED'])).toBe(20);

    const topLevel = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests?limit=200',
      cookies: { qp_session: cookie },
    });
    expect(topLevel.statusCode).toBe(200);
    expect(topLevel.json().jobs).toHaveLength(1);
    expect(topLevel.json().jobs[0]).toMatchObject({ id: sourceId, cloneBatchId: null });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtest-clone-batches/${batchId}`,
      cookies: { qp_session: cookie },
    });
    expect(detail.statusCode).toBe(200);
    const items = detail.json().batch.items as Array<{
      randomSeed: number;
      jobId: string | null;
      status: string;
    }>;
    expect(items).toHaveLength(100);
    expect(new Set(items.map((item) => item.randomSeed)).size).toBe(100);
    expect(items.some((item) => item.randomSeed === buildRequest().randomSeed)).toBe(false);

    const firstQueued = items.find((item) => item.status === 'QUEUED')!;
    expect(ctx.container.jobQueue.setStatus(firstQueued.jobId!, 'STARTING', {}, ['QUEUED'])).toBe(true);
    ctx.container.seedCloneBatchService.onJobStatusChanged();
    const afterSlot = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(afterSlot.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(79);
    expect(ctx.container.jobQueue.countByStatus(['QUEUED'])).toBe(20);

    const child = afterSlot.items.find(({ job }) => job?.cloneBatchId === batchId)?.job;
    expect(child?.cloneSourceJobId).toBe(sourceId);
    const childRequest = JSON.parse(child!.requestJson) as BacktestRequest;
    const { randomSeed: _sourceSeed, ...sourceSettings } = buildRequest();
    const { randomSeed: _childSeed, ...childSettings } = childRequest;
    expect(childSettings).toEqual({ ...sourceSettings, benchmarkId: 'KOSPI', timeframe: '1d' });

    for (let round = 0; round < 6; round += 1) {
      const current = ctx.container.seedCloneBatchService.get(batchId)!;
      for (const { job } of current.items) {
        if (job && !ctx.container.jobQueue.isTerminal(job.status)) {
          ctx.container.jobQueue.setStatus(job.id, 'COMPLETED', {}, [
            'QUEUED', 'STARTING', 'RUNNING', 'CANCELLING',
          ]);
        }
      }
      ctx.container.seedCloneBatchService.onJobStatusChanged();
    }
    const completed = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(completed.batch.status).toBe('COMPLETED');
    expect(completed.items.every(({ item }) => item.state === 'DISPATCHED')).toBe(true);
  });

  it('난수 복제 대기 중 identity 이력이 바뀌면 다음 자식 승격 전에 묶음을 실패시킨다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;
    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 100 },
    });
    expect(response.statusCode).toBe(201);
    const batchId = response.json().batch.id as string;
    const before = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(before.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(80);
    const child = before.items.find(({ item }) => item.state === 'DISPATCHED')!.job!;
    const beforeJobCount = ctx.container.jobQueue.listJobs(500, 0).length;

    ctx.container.database.db.insert(symbolMasterVersions).values({
      standardCode: 'KR7999999999',
      shortCode: '005930',
      validFromDate: '1990-01-01',
      validToDate: '2000-01-01',
      name: '과거 발행사',
      market: 'KOSPI',
      sharesOutstanding: '1',
      instrumentType: 'COMMON_STOCK',
      listedDate: '1990-01-01',
      recordedAtMs: ctx.container.clock.now(),
    }).run();
    expect(ctx.container.jobQueue.setStatus(child.id, 'COMPLETED', {}, ['QUEUED'])).toBe(true);

    ctx.container.seedCloneBatchService.pump();

    const failed = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(failed.batch.status).toBe('FAILED');
    expect(failed.batch.error).toMatch(/단축코드 005930.*여러 표준코드/);
    expect(failed.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(80);
    expect(ctx.container.jobQueue.listJobs(500, 0)).toHaveLength(beforeJobCount);
  });

  it('난수 복제 대기 중 기간 coverage가 사라지면 다음 자식 승격 전에 묶음을 실패시킨다', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;
    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 100 },
    });
    expect(response.statusCode).toBe(201);
    const batchId = response.json().batch.id as string;
    const before = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(before.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(80);
    const child = before.items.find(({ item }) => item.state === 'DISPATCHED')!.job!;
    const beforeJobCount = ctx.container.jobQueue.listJobs(500, 0).length;

    ctx.container.database.db.delete(symbolMasterCoverage).run();
    ctx.container.database.db.insert(symbolMasterCoverage).values(
      ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05']
        .map((date) => ({
          startDate: date,
          endDate: date,
          syncedAtMs: ctx.container.clock.now(),
        })),
    ).run();
    expect(ctx.container.jobQueue.setStatus(child.id, 'COMPLETED', {}, ['QUEUED'])).toBe(true);

    ctx.container.seedCloneBatchService.pump();

    const failed = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(failed.batch.status).toBe('FAILED');
    expect(failed.batch.error).toContain('기간 전체');
    expect(failed.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(80);
    expect(ctx.container.jobQueue.listJobs(500, 0)).toHaveLength(beforeJobCount);
  });

  it('재무 전략 난수 복제 대기 중 필수 연도 coverage가 사라지면 추가 승격을 막는다', async () => {
    const request: BacktestRequest = {
      ...buildRequest(),
      strategyId: 'value-quality-rank',
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
      risk: { maxPositions: 1 },
    };
    await seedValueQualityFacts(ctx.container, ['005930']);
    seedFinancialCoverage(ctx.container, ['005930'], [2025, 2026]);
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: request,
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;
    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 100 },
    });
    expect(response.statusCode).toBe(201);
    const batchId = response.json().batch.id as string;
    const before = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(before.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(80);
    const child = before.items.find(({ item }) => item.state === 'DISPATCHED')!.job!;
    const beforeJobCount = ctx.container.jobQueue.listJobs(500, 0).length;

    ctx.container.database.db.update(symbolFactsState)
      .set({ coveredYearsJson: JSON.stringify([2026]) })
      .where(eq(symbolFactsState.code, '005930'))
      .run();
    expect(ctx.container.jobQueue.setStatus(child.id, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    ctx.container.seedCloneBatchService.pump();

    const failed = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(failed.batch.status).toBe('FAILED');
    expect(failed.batch.error).toMatch(/coverage.*2025~2026년.*005930/);
    expect(failed.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(80);
    expect(ctx.container.jobQueue.listJobs(500, 0)).toHaveLength(beforeJobCount);
  });

  it('난수 복제 대기 중 기간 일봉이 사라지면 다음 자식 승격 전에 묶음을 실패시킨다', async () => {
    registerSymbols(ctx.container, 'KR', ['000660']);
    const request = { ...buildRequest(), universeRule: universeRule(2) };
    seedDailyBars(ctx.container.database.db, [
      {
        symbol: '000660',
        market: 'KR',
        timeframe: '1d',
        tsMs: Date.parse('2025-12-31T00:00:00Z'),
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 1_000,
      },
      ...buildTrendingDailyCandles('000660'),
    ]);
    await seedCorporateActionCoverage(ctx.container, ['000660'], ACTION_COVERAGE_YEARS);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: request,
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;
    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 100 },
    });
    expect(response.statusCode).toBe(201);
    const batchId = response.json().batch.id as string;
    const before = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(before.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(80);
    const child = before.items.find(({ item }) => item.state === 'DISPATCHED')!.job!;
    const beforeJobCount = ctx.container.jobQueue.listJobs(500, 0).length;

    ctx.container.database.db
      .delete(krxDailyBars)
      .where(and(
        eq(krxDailyBars.shortCode, '000660'),
        gte(krxDailyBars.date, request.period.from),
        lte(krxDailyBars.date, request.period.to),
      ))
      .run();
    expect(ctx.container.jobQueue.setStatus(child.id, 'COMPLETED', {}, ['QUEUED'])).toBe(true);

    ctx.container.seedCloneBatchService.pump();

    const failed = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(failed.batch.status).toBe('FAILED');
    expect(failed.batch.error).toMatch(/000660.*일봉|일봉.*000660/);
    expect(failed.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(80);
    expect(ctx.container.jobQueue.listJobs(500, 0)).toHaveLength(beforeJobCount);
  });

  it('재무 전략 난수 복제 대기 중 마지막 PIT 재무 행이 사라지면 추가 승격을 막는다', async () => {
    const request: BacktestRequest = {
      ...buildRequest(),
      strategyId: 'value-quality-rank',
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
      risk: { maxPositions: 1 },
    };
    await seedValueQualityFacts(ctx.container, ['005930']);
    seedFinancialCoverage(ctx.container, ['005930'], [2025, 2026]);
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: request,
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().job.id as string;
    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 100 },
    });
    expect(response.statusCode).toBe(201);
    const batchId = response.json().batch.id as string;
    const before = ctx.container.seedCloneBatchService.get(batchId)!;
    const child = before.items.find(({ item }) => item.state === 'DISPATCHED')!.job!;
    const beforeJobCount = ctx.container.jobQueue.listJobs(500, 0).length;

    ctx.container.database.db.delete(facts)
      .where(eq(facts.key, '005930'))
      .run();
    // coverage 무결성 단계는 다시 닫아 두고, 그 다음의 실제 PIT fact 관문이 비어 있는
    // snapshot을 막는지 확인한다.
    seedFinancialCoverage(ctx.container, ['005930'], [2025, 2026]);
    expect(ctx.container.jobQueue.setStatus(child.id, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    ctx.container.seedCloneBatchService.pump();

    const failed = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(failed.batch.status).toBe('FAILED');
    expect(failed.batch.error).toMatch(/준비 완료 후.*PIT 재무.*005930/);
    expect(failed.items.filter(({ item }) => item.state === 'PENDING')).toHaveLength(80);
    expect(ctx.container.jobQueue.listJobs(500, 0)).toHaveLength(beforeJobCount);
  });

  it('난수 시드 실험 취소는 새 승격을 막고 대기 중인 자식도 취소한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: buildRequest(),
    });
    const sourceId = created.json().job.id as string;
    ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED']);
    const batchResponse = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 100 },
    });
    const batchId = batchResponse.json().batch.id as string;

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtest-clone-batches/${batchId}/cancel`,
      cookies: { qp_session: cookie },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().batch).toMatchObject({
      status: 'CANCELLED',
      cancelledCount: 100,
      pendingCount: 0,
      queuedCount: 0,
    });
    expect(ctx.container.jobQueue.countByStatus(['QUEUED'])).toBe(0);
  });

  it('난수 시드 실험 취소는 실행 중 자식이 끝날 때까지 CANCELLING을 유지한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: buildRequest(),
    });
    const sourceId = created.json().job.id as string;
    ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED']);
    const batchResponse = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 3 },
    });
    const batchId = batchResponse.json().batch.id as string;
    const beforeCancel = ctx.container.seedCloneBatchService.get(batchId)!;
    const runningJob = beforeCancel.items[0]!.job!;
    expect(
      ctx.container.jobQueue.setStatus(runningJob.id, 'RUNNING', {}, ['QUEUED']),
    ).toBe(true);

    const cancelling = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtest-clone-batches/${batchId}/cancel`,
      cookies: { qp_session: cookie },
    });
    expect(cancelling.statusCode).toBe(200);
    expect(cancelling.json().batch).toMatchObject({
      status: 'CANCELLING',
      runningCount: 1,
      queuedCount: 0,
      pendingCount: 0,
      cancelledCount: 2,
      completedAtMs: null,
    });

    expect(
      ctx.container.jobQueue.setStatus(runningJob.id, 'CANCELLED', {}, ['RUNNING']),
    ).toBe(true);
    ctx.container.seedCloneBatchService.onJobStatusChanged();

    const cancelled = ctx.container.seedCloneBatchService.get(batchId)!;
    expect(cancelled.batch.status).toBe('CANCELLED');
    expect(cancelled.batch.completedAtMs).not.toBeNull();
  });

  it('실행 중인 난수 실험 삭제는 막고 취소 완료 뒤에는 원본을 남긴 채 단독 삭제한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: buildRequest(),
    });
    const sourceId = created.json().job.id as string;
    ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED']);
    const batchResponse = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 2 },
    });
    const batchId = batchResponse.json().batch.id as string;
    const childIds = ctx.container.seedCloneBatchService.get(batchId)!.items
      .flatMap(({ job }) => job === null ? [] : [job.id]);

    const activeBatchDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/backtest-clone-batches/${batchId}`,
      cookies: { qp_session: cookie },
    });
    expect(activeBatchDelete.statusCode).toBe(409);

    const activeSourceDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/backtests/${sourceId}`,
      cookies: { qp_session: cookie },
    });
    expect(activeSourceDelete.statusCode).toBe(409);

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtest-clone-batches/${batchId}/cancel`,
      cookies: { qp_session: cookie },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().batch.status).toBe('CANCELLED');

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/backtest-clone-batches/${batchId}`,
      cookies: { qp_session: cookie },
    });
    expect(deleted.statusCode).toBe(204);
    expect(ctx.container.seedCloneBatchService.get(batchId)).toBeNull();
    expect(ctx.container.jobQueue.getJob(sourceId)).not.toBeNull();
    expect(childIds.every((id) => ctx.container.jobQueue.getJob(id) === null)).toBe(true);
  });

  it('원본 삭제는 종료된 난수 실험 묶음과 모든 자식 백테스트를 함께 삭제한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: buildRequest(),
    });
    const sourceId = created.json().job.id as string;
    ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED']);

    const batchIds: string[] = [];
    for (const count of [2, 3]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
        cookies: { qp_session: cookie },
        payload: { count },
      });
      expect(response.statusCode).toBe(201);
      batchIds.push(response.json().batch.id as string);
    }

    const childIds = batchIds.flatMap((batchId) =>
      ctx.container.seedCloneBatchService.get(batchId)!.items
        .flatMap(({ job }) => job === null ? [] : [job.id]));
    for (const childId of childIds) {
      expect(ctx.container.jobQueue.setStatus(childId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    }
    ctx.container.seedCloneBatchService.onJobStatusChanged();
    expect(batchIds.every(
      (batchId) => ctx.container.seedCloneBatchService.get(batchId)?.batch.status === 'COMPLETED',
    )).toBe(true);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/backtests/${sourceId}`,
      cookies: { qp_session: cookie },
    });
    expect(deleted.statusCode).toBe(204);
    expect(ctx.container.jobQueue.getJob(sourceId)).toBeNull();
    expect(batchIds.every((batchId) => ctx.container.seedCloneBatchService.get(batchId) === null)).toBe(true);
    expect(childIds.every((childId) => ctx.container.jobQueue.getJob(childId) === null)).toBe(true);
  });

  it('seed 자식의 신규 중첩 실험은 막고 기존 중첩은 활성 후손까지 검사해 재귀 삭제한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: buildRequest(),
    });
    const sourceId = created.json().job.id as string;
    ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED']);
    const parentResponse = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 1 },
    });
    const parentBatchId = parentResponse.json().batch.id as string;
    const parentChildId = ctx.container.seedCloneBatchService.get(parentBatchId)!.items[0]!.job!.id;
    ctx.container.jobQueue.setStatus(parentChildId, 'COMPLETED', {}, ['QUEUED']);
    ctx.container.seedCloneBatchService.onJobStatusChanged();

    const rejectedNested = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${parentChildId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 1 },
    });
    expect(rejectedNested.statusCode).toBe(409);
    expect(rejectedNested.json().error).toContain('원본 백테스트에서 시작하세요');

    // 이전 버전에서 이미 만들어진 중첩 데이터를 재현한다. 생성 순간에만 일반 원본처럼
    // 보이게 하고, 곧바로 실제 계보를 복원한다.
    ctx.container.database.db.update(backtestJobs)
      .set({ cloneBatchId: null })
      .where(eq(backtestJobs.id, parentChildId))
      .run();
    const legacyNested = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${parentChildId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 1 },
    });
    expect(legacyNested.statusCode).toBe(201);
    ctx.container.database.db.update(backtestJobs)
      .set({ cloneBatchId: parentBatchId })
      .where(eq(backtestJobs.id, parentChildId))
      .run();
    const nestedBatchId = legacyNested.json().batch.id as string;
    const nestedChildId = ctx.container.seedCloneBatchService.get(nestedBatchId)!.items[0]!.job!.id;

    const blocked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/backtest-clone-batches/${parentBatchId}`,
      cookies: { qp_session: cookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(ctx.container.seedCloneBatchService.get(parentBatchId)).not.toBeNull();
    expect(ctx.container.seedCloneBatchService.get(nestedBatchId)).not.toBeNull();

    const blockedSource = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/backtests/${sourceId}`,
      cookies: { qp_session: cookie },
    });
    expect(blockedSource.statusCode).toBe(409);
    expect(ctx.container.jobQueue.getJob(sourceId)).not.toBeNull();

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtest-clone-batches/${nestedBatchId}/cancel`,
      cookies: { qp_session: cookie },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().batch.status).toBe('CANCELLED');

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/backtest-clone-batches/${parentBatchId}`,
      cookies: { qp_session: cookie },
    });
    expect(deleted.statusCode).toBe(204);
    expect(ctx.container.seedCloneBatchService.get(parentBatchId)).toBeNull();
    expect(ctx.container.seedCloneBatchService.get(nestedBatchId)).toBeNull();
    expect(ctx.container.jobQueue.getJob(parentChildId)).toBeNull();
    expect(ctx.container.jobQueue.getJob(nestedChildId)).toBeNull();
    expect(ctx.container.jobQueue.getJob(sourceId)).not.toBeNull();
  });

  it('난수 실험 목록은 기본 50개 job 페이지 밖의 원본 요약도 함께 반환한다', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: buildRequest(),
    });
    const sourceId = created.json().job.id as string;
    ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED']);
    const batchResponse = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${sourceId}/clone-random-seeds`,
      cookies: { qp_session: cookie },
      payload: { count: 1 },
    });
    expect(batchResponse.statusCode).toBe(201);
    ctx.container.database.db.update(backtestJobs)
      .set({ createdAtMs: 1 })
      .where(eq(backtestJobs.id, sourceId))
      .run();
    for (let index = 0; index < 50; index += 1) {
      ctx.container.jobQueue.enqueue({ ...buildRequest(), randomSeed: 1_000 + index });
    }

    const jobsResponse = await ctx.app.inject({
      method: 'GET', url: '/api/v1/backtests', cookies: { qp_session: cookie },
    });
    expect(jobsResponse.statusCode).toBe(200);
    expect(jobsResponse.json().jobs).toHaveLength(50);
    expect(jobsResponse.json().jobs.some((job: { id: string }) => job.id === sourceId)).toBe(false);

    const batchesResponse = await ctx.app.inject({
      method: 'GET', url: '/api/v1/backtest-clone-batches', cookies: { qp_session: cookie },
    });
    expect(batchesResponse.statusCode).toBe(200);
    expect(batchesResponse.json().sourceJobs).toEqual([
      expect.objectContaining({ id: sourceId, cloneBatchId: null }),
    ]);
  });

  it('초안은 방향 없는 기존 가격 변동 단계를 과거 LOW 방향으로 복원한다', async () => {
    const current = buildRequest();
    const job = ctx.container.jobQueue.enqueue({
      ...current,
      universeRule: {
        markets: ['KOSPI'],
        stages: [{ criterion: 'DECLINE', limit: 20, lookbackTradingDays: 20 }],
        rebalanceInterval: { value: 1, unit: 'MONTH' },
      },
    } as never);

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });

    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { request: BacktestRequest };
    expect(body.request.universeRule.stages).toEqual([
      { criterion: 'DECLINE', direction: 'LOW', limit: 20, lookbackTradingDays: 20 },
    ]);
  });

  it('재무가 필요한 원본도 유니버스 단계 전에는 blockers 없이 연다', async () => {
    const request: BacktestRequest = {
      ...buildRequest(),
      strategyId: 'value-quality-rank',
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
    };
    const job = ctx.container.jobQueue.enqueue(request);

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { request: BacktestRequest; blockers: string[] };
    expect(body.request.strategyId).toBe('value-quality-rank');
    expect(body.blockers).toEqual([]);
  });

  it('여러 단계(PER 우선) 규칙도 유니버스 검증 없이 초안으로 복원한다', async () => {
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(),
      universeRule: {
        markets: ['KOSPI'],
        stages: [
          { criterion: 'PER', direction: 'LOW', limit: 5 },
          { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 },
        ],
        rebalanceInterval: { value: 1, unit: 'MONTH' },
      },
    });

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { request: BacktestRequest; blockers: string[] };
    expect(body.request.universeRule.stages[0]?.criterion).toBe('PER');
    expect(body.blockers).toEqual([]);
  });

  it('일부 종목만 봉이 없으면 그 종목을 제외하고 나머지로 제출한다', async () => {
    // 종목을 하나 더 등록하고 topN 을 2로 올려 유니버스에 넣되 봉은 넣지 않는다 —
    // 준비가 이 종목만 제외하고 005930의 순위와 실행은 유지해야 한다.
    ctx.container.symbolService.addSymbol('000660', 'KR', null, 'KR7000660001');
    // 000660 도 unionSymbols 에 들어오므로 자본변동 게이트도 통과해 둬야 한다
    await seedCorporateActionCoverage(ctx.container, ['000660'], ACTION_COVERAGE_YEARS);

    const partial = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(), universeRule: universeRule(2) },
    });
    expect(partial.statusCode).toBe(201);
    expect((partial.json() as { warnings: string[] }).warnings.join(' ')).toMatch(
      /가격 정보를 온전히 확보할 수 없어 종목 000660을 매매 대상에서 제외/,
    );
  });

  it('봉이 없는 원본도 초기 단계에서는 coverage 검증 없이 연다', async () => {
    // 봉이 없는 기간은 준비 완료 대상이 아니지만 유니버스 단계 전의 초안 복원을 막지 않는다.
    const request: BacktestRequest = {
      ...buildRequest(),
      period: { from: NO_CANDLE_DATE, to: '2020-12-31' },
    };
    const job = ctx.container.jobQueue.enqueue(request);

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { request: BacktestRequest; blockers: string[] };
    // 원본 값은 그대로 돌려준다 — 사용자가 이 값을 보고 고친다
    expect(body.request.period.from).toBe(NO_CANDLE_DATE);
    expect(body.blockers).toEqual([]);
  });

  it('없는 작업의 초안 조회는 404를 반환한다', async () => {
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/job_nope/clone-draft',
      cookies: { qp_session: cookie },
    });
    expect(missing.statusCode).toBe(404);

  });

  it('대기열 상한을 넘는 제출을 429 로 거부한다 (신규·복제 공통)', async () => {
    const small = await createTestApp({ MAX_QUEUED_BACKTESTS: '3' });
    try {
      installPreparedSubmissionFixture(small);
      const { username, password } = await createTestAdmin(small.container);
      const login = await small.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const smallCookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      registerSymbols(small.container, 'KR', ['005930']);
      seedDailyBars(small.container.database.db, buildTrendingDailyCandles());
      seedMaster(small.container, [MAIN_DATE]);
      await seedCorporateActionCoverage(small.container, ['005930'], ACTION_COVERAGE_YEARS);
      const payload = buildRequest();

      // 오케스트레이터를 tick 하지 않으므로 전부 QUEUED 로 남는다
      for (let i = 0; i < 3; i += 1) {
        const accepted = await small.app.inject({
          method: 'POST',
          url: '/api/v1/backtests',
          cookies: { qp_session: smallCookie },
          payload,
        });
        expect(accepted.statusCode).toBe(201);
      }

      const rejected = await small.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: smallCookie },
        payload,
      });
      expect(rejected.statusCode).toBe(429);
      expect((rejected.json() as { error: string }).error).toContain('대기');

      // 복제도 같은 상한을 받는다
      const queued = small.container.jobQueue.listJobs(1, 0)[0]!;
      const clonedOverLimit = await small.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${queued.id}/clone`,
        cookies: { qp_session: smallCookie },
      });
      expect(clonedOverLimit.statusCode).toBe(429);
    } finally {
      await small.close();
    }
  });

  it('기간이 뒤집힌 제출은 데이터 부족이 아니라 기간 오류로 거부한다', async () => {
    const inverted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(), period: { from: '2026-03-31', to: '2026-01-05' } },
    });
    expect(inverted.statusCode).toBe(400);
    expect((inverted.json() as { error: string }).error).toContain('기간이 올바르지 않습니다');
  });
});
