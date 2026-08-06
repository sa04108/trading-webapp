import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';
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

/** UTC epoch ms(자정) → krxDailyBars.date 텍스트('YYYY-MM-DD') */
function toIsoDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/** 이 파일의 테스트가 리밸런스 날짜로 쓰는 값 전부 — 종목 마스터 시총 캐시를 이 날짜들로 채운다 */
const MASTER_DATES = ['2025-07-27', '2025-08-01', '2025-09-01', '2025-10-01'];

function universeRule(topN: number): BacktestRequest['universeRule'] {
  return { markets: ['KOSPI'], topN, sortKey: 'MKTCAP' };
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

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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

    // 증권사 일봉 동기화가 만드는 상태를 그대로 재현한다 (로컬 종목 등록 + 1d 파티션)
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);
    seedSymbolMasterUniverse(ctx.container, MASTER_DATES, [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
      { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSPI', marketCapKrw: '1000000000000' },
    ]);
    dailyCandles = buildDailyCandles();
    await ctx.container.candleRepository.saveCandles(dailyCandles);
    await ctx.container.symbolService.refreshCoverage('005930', 'KR', '1d');
    ctx.container.symbolService.bumpVersion('005930', '1d', 'broker:seed', Date.now());
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('커버리지가 보고한 일봉으로 백테스트가 완주한다', { timeout: 90_000 }, async () => {
    // 사용자가 보는 화면: 커버리지는 봉이 있다고 말한다
    const coverage = ctx.container.symbolService.getCoverage(['005930']);
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
  });

  it('봉이 없는 종목을 실행 경고로 남긴다', { timeout: 90_000 }, async () => {
    // topN=2 로 올리면 시총 2위(000660, 봉 없음)도 유니버스에 들어온다 —
    // 제출 검증은 통과하고(005930 이 겹치므로 D-025 관용) 실행에서 그 종목만 빠진다
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

    const run = ctx.container.resultsService.getRun(jobId)!;
    const warnings = JSON.parse(run.warningsJson ?? '[]') as string[];
    expect(warnings.some((w) => w.includes('000660'))).toBe(true);
  });

  it('재무가 없는 데이터셋에 밸류 전략을 제출하면 422 로 거부한다', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        strategyId: 'value-quality-rank',
        parameters: { topN: 20, rebalanceMonths: 3, staleQuarters: 2 },
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
    expect(response.json().error).toContain('상장시점 재무 데이터가 필요');
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
      universeRule: universeRule(1),
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

  it('topN 이 최대 동시 보유 종목 수보다 크면 422 로 거부한다', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: momentumPayload(20, 10),
    });

    expect(response.statusCode).toBe(422);
    const error = response.json().error as string;
    // 두 숫자를 다 밝히고 무엇을 고쳐야 하는지 말해야 한다
    expect(error).toContain('20');
    expect(error).toContain('10');
    expect(error).toContain('최대 동시 보유 종목 수');
  });

  it('topN === maxPositions 는 통과한다 — 게이트가 전부를 막지 않는다', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: momentumPayload(10, 10),
    });
    expect(response.statusCode).toBe(201);
  });

  it('clone-draft 는 같은 조건을 blockers 로 알린다 (막지 않고 고칠 화면은 열어준다)', async () => {
    // 게이트가 생기기 전에 제출된 잡을 재현한다 — 큐에 직접 넣어 제출 검증을 우회한다
    const job = ctx.container.jobQueue.enqueue(momentumPayload(20, 10) as never, [], { entries: [], hash: 'seed' });

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const blockers = draft.json().blockers as string[];
    expect(blockers.some((b) => b.includes('최대 동시 보유 종목 수'))).toBe(true);

    // 그리고 실제 복제 제출은 422 로 막힌다
    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(422);
    expect(cloned.json().error).toContain('최대 동시 보유 종목 수');
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
 * 생존편향 제거 회귀(설계 2026-08-06-krx-daily-bars) — 자식 프로세스가 실제로
 * CompositeCandleRepository 를 쓰는지의 유일한 증거다.
 *
 * 이 종목은 parquet 에 **전혀 저장하지 않는다** — krx_daily_bars 테이블에만 일봉을
 * 넣는다(증권사가 상장폐지 종목의 봉을 안 주는 상황을 그대로 흉내낸다). 부모 프로세스의
 * `container.candleRepository`(composite)로 미리보기·커버리지를 봤을 때 봉이 있는
 * 것처럼 보여도, 워커(`backtest-child.ts`)가 여전히 `ParquetCandleRepository` 를
 * 직접 만들면 실행 시점에는 0봉이라 "선택한 기간·종목에 데이터가 없습니다" 로 실패한다.
 * `ctx.container.jobOrchestrator.tick()` 이 실제로 자식 프로세스를 fork 하므로, 이
 * 테스트만이 워커 경로까지 검증한다 — 부모 프로세스 안에서 도는 다른 단위 테스트는
 * 이 불일치를 볼 수 없다.
 */
describe('KRX 전용 일봉으로 백테스트 실행 (워커의 생존편향 제거)', () => {
  const KRX_ONLY_CODE = '900001'; // 가상의 상장폐지 종목 — parquet 에는 없고 krx_daily_bars 에만 있다

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

    // parquet 저장(saveCandles)은 호출하지 않는다 — krx_daily_bars 테이블에만 직접 넣는다
    krxOnlyCandles = buildDailyCandles(KRX_ONLY_CODE);
    ctx.container.database.db
      .insert(krxDailyBars)
      .values(
        krxOnlyCandles.map((candle) => ({
          shortCode: KRX_ONLY_CODE,
          date: toIsoDate(candle.tsMs),
          market: 'KOSPI',
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        })),
      )
      .run();
    // 제출 검증이 보는 커버리지·버전은 candleRepository(composite)를 거쳐 계산된다 —
    // KRX 테이블만 있어도 이 두 호출로 "수집된 봉이 있다"는 상태가 된다.
    await ctx.container.symbolService.refreshCoverage(KRX_ONLY_CODE, 'KR', '1d');
    ctx.container.symbolService.bumpVersion(KRX_ONLY_CODE, '1d', 'broker:seed', Date.now());
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('parquet 에 없고 KRX 일봉만 있는 종목도 워커에서 체결까지 완주한다', { timeout: 90_000 }, async () => {
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
    // 회귀 지점: 워커가 여전히 parquet 만 보면 여기서 '데이터가 없습니다' 로 실패한다
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
