import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import {
  krxDailyBars,
  krxNonTradingCoverage,
  krxNonTradingDays,
  symbolMasterStorageState,
  symbolMasterVersions,
} from '../../src/server/shared/db/schema.js';
import {
  DEFAULT_EXECUTION_RULES,
  getCostProfile,
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
    seedDailyBars(ctx.container.database.db, dailyCandles);
    // 자본변동 게이트(Task 6) — 이 파일의 제출 기간이 걸치는 연도(2025·2026)를 채운다
    seedCorporateActionCoverage(ctx.container, ['005930', '000660'], yearRange(2025, 2026));
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
    const metrics = ctx.container.resultsService.getMetrics(jobId) as { totalReturnPct: number };
    expect(ctx.container.resultsService.getTotalReturnPct(jobId)).toBe(metrics.totalReturnPct);
    // 결과가 없는 잡은 null 이다 — 0 으로 떨어지면 "수익 0%" 로 읽힌다
    expect(ctx.container.resultsService.getTotalReturnPct('bt_없는잡')).toBeNull();

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
 * 부모-자식 프로세스 봉 조회 회귀. `ctx.container.jobOrchestrator.tick()` 이 실제로
 * 자식 프로세스를 fork 한다. 자식이 부모와 별도로 `krx_daily_bars` 를 읽어 백테스트를
 * 완주하는지는 이 테스트만 검증한다 — 부모 프로세스 안에서 도는 단위 테스트는 이
 * 경계를 볼 수 없다.
 *
 * `CompositeCandleRepository`·`ParquetCandleRepository` 는 이제 없다(Task 5,
 * 2026-08-07-price-data-removal). `krx_daily_bars` 가 유일한 봉 원천이다.
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
    seedCorporateActionCoverage(ctx.container, [KRX_ONLY_CODE], yearRange(2025, 2026));
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

/**
 * clone 의 유니버스 등록 누락이다(리뷰 finding, 브랜치 fix/inplace-candle-sync).
 * `POST /backtests/universe-preview` 는 `registerUniverseSymbols` 를 부른다.
 * 상세 화면의 원클릭 복제(`POST /backtests/:id/clone`)는 `validateSubmission` 만
 * 거쳐 이 호출을 건너뛰었다.
 *
 * 위저드 화면은 제출 전 항상 미리보기를 거치므로 이 등록이 이미 끝나 있다.
 * 복제는 미리보기 화면 자체를 거치지 않는다. 리밸런스 시점 시총이 바뀌어 새로
 * topN 에 든 종목처럼, 미리보기에서 한 번도 보지 못한 종목이 있으면 문제가 된다.
 * `checkPeriodCoverage` 는 유니버스 중 일부만 데이터가 있어도 통과시키므로(D-025)
 * 실행 자체는 되지만, 가격 데이터 탭에는 그 종목이 보이지 않는 불일치가 남는다.
 *
 * 이 테스트는 미리보기를 거치지 않고(검증을 우회해 큐에 직접 넣어) 만든 잡을
 * 복제한다. 이미 등록된 종목(005930) 옆에 미등록 종목 900010(KRX 일봉만 있음)을
 * 둔다. 900010 은 로컬 등록도 자본변동 수집도 없다.
 *
 * 등록은 `checkPeriodCoverage` 의 D-025 관용과 무관하게 clone 핸들러가 검증보다
 * 먼저 실행한다 — 그래서 900010 은 항상 등록된다.
 * 다만 자본변동 게이트(Task 6)는 종목 하나하나를 다 채워야 하므로, 등록 직후에도
 * 900010 이 자본변동을 수집하지 않았다면 최종 제출은 400 으로 막힌다.
 * 수정 전에는 clone 이 201 로 성공하면서도 900010 을 등록하지 않아 등록 단언이
 * 실패했다 — 지금은 그 등록 단언에 더해 자본변동 게이트 상호작용까지 함께 지킨다.
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
    // 삽입) — 다만 이 종목은 미리보기를 한 번도 거치지 않아 로컬 `symbols` 등록도,
    // 커버리지 캐시도 없다.
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

    // 자본변동 게이트(Task 6) — 005930 은 수집을 마쳤다고 둔다.
    // 900010 은 아직 로컬 미등록이라 여기서 심을 수 없다(symbol_facts_state 의
    // FK 가 symbols 등록을 요구한다) — 그 자체가 "수집한 적 없음" 의 실제 모습이다.
    seedCorporateActionCoverage(ctx.container, ['005930'], yearRange(2026, 2026));
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('미리보기를 거치지 않고 큐에 바로 들어간 잡을 복제하면 unionSymbols 를 등록한다 — 다만 900010 의 자본변동 미수집이 최종 제출은 막는다(Task 6)', async () => {
    expect(ctx.container.symbolService.exists('900010')).toBe(false);

    // 위저드의 미리보기를 거치지 않고 제출된 잡을 재현한다 — clone-draft 테스트와
    // 같은 패턴으로 검증을 우회해 큐에 직접 넣는다.
    const request: BacktestRequest = {
      ...buildRequest(2),
      timeframe: '1d',
      period: { from: date, to: date },
    };
    const job = ctx.container.jobQueue.enqueue(request, [], { entries: [], hash: 'seed' });

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });

    // 등록은 검증보다 먼저 일어난다(ensureUniverseRegistered → validateSubmission
    // 순서, clone 핸들러 참고) — 그래서 최종 제출이 막혀도 등록은 이미 끝나 있다.
    // 미리보기가 했을 일을 clone 도 그대로 해야 가격 데이터 탭에서 빠지지 않는다.
    expect(ctx.container.symbolService.exists('900010')).toBe(true);
    const coverage = ctx.container.candleCoverageService.getCoverage(['900010'])[0]!;
    expect(coverage.barCount).toBe(1);

    // 그래도 900010 은 자본변동을 한 번도 수집하지 않았다 — D-025 캔들 관용과
    // 달리 이 게이트는 종목 하나하나를 다 채워야 한다. 최종 제출은 400 이다.
    expect(cloned.statusCode).toBe(400);
    expect((cloned.json() as { error: string }).error).toContain('900010');

    // 자본변동을 실제로 수집하면(방금 등록됐으므로 이제 FK 를 만족한다) 같은
    // 요청이 통과한다 — 게이트가 '수집 여부' 만 본다는 것을 보여준다.
    seedCorporateActionCoverage(ctx.container, ['900010'], yearRange(2026, 2026));
    const retried = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(retried.statusCode).toBe(201);
  });
});

/**
 * 리뷰 finding(2026-08-08): `checkPeriodCoverage`/`resolveConsumedUniverse` 가
 * `candleCoverage`(원시 `krx_daily_bars`)만 보고 `symbolService.exists` 를 보지
 * 않으면, 유니버스 전체가 미등록이어도 봉만 있으면 제출이 통과해 버린다. 그러면
 * 큐 슬롯을 먹은 뒤 `backtest-child.ts` 가 "유니버스 종목이 등록돼 있지 않습니다"
 * 로 늦게 죽는다 — 제출 시점에 빨리 거부하는 옛 동작(캐시가 등록 종목만 채워졌던
 * 시절의 부작용)을 명시적인 검사로 되살렸는지 이 테스트가 지킨다.
 *
 * `registerSymbols` 를 의도적으로 부르지 않는다 — `krx_daily_bars` 는 백필이 이미
 * 채워 뒀다고 가정하지만 `symbols` 등록은 한 번도 거치지 않은 상태를 재현한다.
 */
describe('POST /backtests — 미등록 유니버스는 제출 시점에 거부된다 (리뷰 finding, 2026-08-08)', () => {
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

  it('종목이 봉을 갖고 있어도 하나도 등록돼 있지 않으면 400 이다', async () => {
    expect(ctx.container.symbolService.exists(UNREGISTERED_CODE)).toBe(false);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(1), period: { from: date, to: date } },
    });

    expect(created.statusCode).toBe(400);
    expect((created.json() as { error: string }).error).toContain('등록');
    // 큐에 남지 않아야 한다 — 늦게 죽는 게 아니라 애초에 들어가지 않아야 한다.
    expect(ctx.container.jobQueue.countByStatus(['QUEUED'])).toBe(0);
  });
});

/**
 * 자본변동 수집 게이트(Task 6). 엔진은 이제 액면분할을 걸친 포지션을 조정하지만
 * (Task 1·2), 자본변동 이력을 받아본 적 없는 종목은 분할이 있었는지 알 도리가
 * 없어 결과가 조용히 틀린다.
 *
 * 팩트 0건은 세 상태를 가릴 수 있다: 수집했고 분할이 없다, 수집했는데 DART 가
 * 응답하지 못했다, 아예 수집하지 않았다. 커버리지가 셋째를 앞의 둘과 가르고,
 * gap 이 첫째와 둘째를 가른다. 이 묶음은 그 세 갈래를 그대로 재현한다.
 */
describe('POST /backtests — 자본변동 수집 게이트 (Task 6)', () => {
  const date = '2026-01-05';
  const CODE = '900050';

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

    // 봉·등록·종목 마스터는 모두 갖춘다 — 자본변동 커버리지만 이 게이트가 보는 유일한 변수다.
    // 이름까지 등록해야 에러·경고 문구가 종목을 이름으로 밝히는지 확인할 수 있다.
    ctx.container.symbolService.addSymbol(CODE, 'KR', '게이트테스트');
    seedSymbolMasterUniverse(ctx.container, [date], [
      {
        standardCode: 'KR7900050006',
        shortCode: CODE,
        name: '게이트테스트',
        market: 'KOSPI',
        marketCapKrw: '500000000000000',
      },
    ]);
    seedDailyBars(ctx.container.database.db, [
      {
        symbol: CODE,
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
  });

  afterEach(async () => {
    await ctx.close();
  });

  const submit = (): Promise<{ statusCode: number; json: () => Record<string, unknown> }> =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(1), period: { from: date, to: date } },
    });

  it('자본변동을 수집하지 않은 종목이 있으면 400 이다', async () => {
    // 커버리지 저장소에 아무것도 심지 않는다 — "아예 수집하지 않음" 을 재현한다.
    const created = await submit();

    expect(created.statusCode).toBe(400);
    const body = created.json() as {
      error: string;
      corporateActionGate?: { symbols: string[]; fromYear: number; toYear: number };
    };
    expect(body.error).toContain(CODE);
    expect(body.error).toContain('게이트테스트');
    // 큐에 남지 않아야 한다 — 워커까지 가서 늦게 죽는 게 아니라 제출 시점에 막힌다.
    expect(ctx.container.jobQueue.countByStatus(['QUEUED'])).toBe(0);

    // 위저드 게이트 화면(Task 8)이 이 값을 그대로 받아 쓴다 — 화면이 종목·연도를
    // 다시 계산하지 않는다.
    expect(body.corporateActionGate).toEqual({ symbols: [CODE], fromYear: 2026, toYear: 2026 });
  });

  it('수집했고 분할이 없는 종목은 통과한다', async () => {
    // 커버리지만 있고 팩트는 0건이다 — "수집했고 분할이 없었다" 상태.
    seedCorporateActionCoverage(ctx.container, [CODE], [2026]);

    const created = await submit();

    expect(created.statusCode).toBe(201);
  });

  it('gap 이 난 종목은 통과하고 경고에 이름이 나온다', async () => {
    // 커버리지도 있고 gap 도 있다 — "수집했는데 DART 가 응답하지 못했다" 상태.
    seedCorporateActionCoverage(ctx.container, [CODE], [2026]);
    ctx.container.actionCoverageStore.addGapYears(CODE, [2026], ctx.container.clock.now());

    const created = await submit();

    expect(created.statusCode).toBe(201);
    const warnings = (created.json() as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes(CODE))).toBe(true);

    // 응답에만 실어 보내면 토스트 10초가 유일한 수명이 된다 — job 에도 남아야 한다
    const jobId = (created.json().job as { id: string }).id;
    const stored = ctx.container.jobQueue.getJob(jobId)!;
    expect(JSON.parse(stored.submitWarningsJson!)).toEqual(warnings);
  });

  /**
   * clone-draft 는 "검증을 돌리되 막지 않는다" — 그런데 비차단 경고까지 함께
   * 삼키면 위저드가 자본변동 위험을 안내할 길이 없다(리뷰 finding, 2026-08-08).
   */
  it('gap 이 있는 잡의 clone-draft 도 경고를 낸다 (리뷰 finding, 2026-08-08)', async () => {
    seedCorporateActionCoverage(ctx.container, [CODE], [2026]);
    ctx.container.actionCoverageStore.addGapYears(CODE, [2026], ctx.container.clock.now());

    // 검증을 우회해 큐에 직접 넣는다 — clone-draft 는 대기열 상태와 무관하게 동작한다.
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(1),
      period: { from: date, to: date },
    });

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });

    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { warnings: string[]; blockers: string[] };
    expect(body.warnings.some((w) => w.includes(CODE))).toBe(true);
    // 차단 사유가 아니라 경고다 — blockers 는 비어 있어야 한다.
    expect(body.blockers).toEqual([]);
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
  });

  afterEach(async () => {
    await ctx.close();
  });

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
      seedCorporateActionCoverage(ctx.container, ['005930', '000660'], yearRange(2025, 2026));

      // 마지막 봉 다음 날을 폐지 효력일로 둔다 — 워커가 listEvents 로 이 경계를 읽어
      // 엔진에 넘긴다. SCD 이행(D-045) 후 delistedEventsBetween 은 legacy
      // symbol_master_events 를 더 이상 읽지 않고 symbol_master_versions 의 버전
      // 경계를 diffUniverse 로 비교해 이벤트를 파생한다 — 그래서 여기서도 legacy
      // 테이블에 행을 심는 대신 000660 의 실제 유효 구간을 이 날짜에서 닫아야
      // listEvents 가 DELISTED 경계를 본다. observedSpanStart 앵커(경계 이전 관측
      // 거래일)는 seedSymbolMasterUniverse 가 MASTER_DATES 를 이미 거래일로 심어
      // 뒀으므로 따로 채울 필요가 없다.
      const delistedDate = new Date(lastDoomed.tsMs + DAY).toISOString().slice(0, 10);
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
        rules: DEFAULT_EXECUTION_RULES,
      };
      const expectedFromClose = simulateFill(
        { symbol: '000660', side: 'SELL', quantity: 1, reason: 'DELISTED' },
        lastDoomed.close,
        lastDoomed.tsMs,
        executionProfile,
      );
      const expectedFromOpen = simulateFill(
        { symbol: '000660', side: 'SELL', quantity: 1, reason: 'DELISTED' },
        lastDoomed.open,
        lastDoomed.tsMs,
        executionProfile,
      );
      expect(delistingTrade?.exitPrice).toBe(expectedFromClose.price);
      expect(delistingTrade?.exitPrice).not.toBe(expectedFromOpen.price);
      expect(delistingTrade?.exitTsMs).toBe(lastDoomed.tsMs);

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
      seedCorporateActionCoverage(ctx.container, ['005930', '000660'], yearRange(2025, 2026));

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
    '종목 마스터가 SCD 이행 전이면 워커는 이행하지 않고 바로 실패한다',
    { timeout: 90_000 },
    async () => {
      // 워커가 SymbolMasterService 를 만들면 생성자가 ensureScdStorageReady 를 부른다 —
      // 백테스트 잡 하나가 트랜잭션을 열어 버전 테이블을 다시 쓰고 legacy 테이블을
      // 비우는 이행을 수행하게 된다. 워커는 절대 이행하지 않고, 운영자에게 서버를
      // 먼저 띄우라고 말하고 죽어야 한다.
      const alive = buildDailyCandles('005930');
      registerSymbols(ctx.container, 'KR', ['005930']);
      seedDailyBars(ctx.container.database.db, alive);
      seedSymbolMasterUniverse(ctx.container, MASTER_DATES, [
        { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '900' },
      ]);
      seedCorporateActionCoverage(ctx.container, ['005930'], yearRange(2025, 2026));

      // 제출은 이행이 끝난 서버가 받는다. 워커가 열 때만 PENDING 이다 —
      // 서버 배포와 워커 실행 사이에 DB 가 교체된 상황이 이 모양이다.
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: buildRequest(1),
      });
      expect(created.statusCode).toBe(201);
      const jobId = (created.json().job as { id: string }).id;

      ctx.container.database.db
        .update(symbolMasterStorageState)
        .set({ phase: 'PENDING', migratedAtMs: null })
        .where(eq(symbolMasterStorageState.singleton, 1))
        .run();
      const versionsBefore = ctx.container.database.db.select().from(symbolMasterVersions).all();

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      expect(job.status).toBe('FAILED');
      // 이행을 시도하다 죽은 것이 아니라, 시도 전에 멈춰 운영자에게 할 일을 알린다
      expect(job.error).toContain('서버를 먼저');
      expect(job.error).not.toContain('SCD 이행 실패');

      // 이행 흔적이 없어야 한다 — 상태도 버전 행도 그대로다
      const state = ctx.container.database.db
        .select()
        .from(symbolMasterStorageState)
        .where(eq(symbolMasterStorageState.singleton, 1))
        .get();
      expect(state?.phase).toBe('PENDING');
      expect(ctx.container.database.db.select().from(symbolMasterVersions).all())
        .toHaveLength(versionsBefore.length);
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
      seedCorporateActionCoverage(ctx.container, ['005930', '000660'], yearRange(2025, 2026));

      // 이 파일의 유일한 리밸런스 날짜는 period.from(2025-07-27) 이다 — range-breakout 은
      // rebalanceMonths 파라미터가 없어 제출 경로가 단일 리밸런스로 접는다
      // (backtest-routes.ts resolveUniverse). 그 날짜에 000660 을 거래정지로 심으면
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
