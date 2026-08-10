import { and, desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../src/server/modules/backtest/domain/engine.js';
import { FACTS_SLICE } from '../../src/server/modules/market-data/application/symbol-service.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { symbolVersions } from '../../src/server/shared/db/schema.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { currentStrategyVersion } from '../helpers/strategy-versions.js';
import {
  createTestAdmin,
  createTestApp,
  installPreparedSubmissionFixture,
  type TestApp,
} from '../helpers/test-app.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars, yearRange } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

const DAY = 86_400_000;

const STRATEGY_ID = 'range-breakout';
/** 재기준 테스트가 흉내 내는 "과거 스키마" 요청의 버전 — 현재 버전과 다르기만 하면 된다 */
const LEGACY_VERSION = '1.1.0';

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
    stages: [{ criterion: 'MARKET_CAP', limit: topN }],
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
    installPreparedSubmissionFixture(ctx);

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

  it('runs a backtest end-to-end in a child process', { timeout: 90_000 }, async () => {
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
    expect(body.run.feeModelVersion).toBe('kr-equity-default@1.1.0');
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
    // 정렬 파라미터가 없으면 청산 시각 오름차순이다 — 예전 순서가 그대로여야 한다
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
    expect((exported.json() as { equityPoints: unknown[] }).equityPoints).toHaveLength(
      dailyCandles.length,
    );

    // clone → 새 QUEUED 작업
    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${jobId}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(201);
    expect(cloned.json().job.status).toBe('QUEUED');
  });

  it('요청한 부분 유니버스 종목만 제출 시점 버전으로 pin 한다', async () => {
    // 000660 이 시총 2위라 topN=1(기본값) 이면 유니버스에서 자연히 빠진다 —
    // 옛 "데이터셋은 2종목인데 요청은 1종목만 지정" 과 같은 결과를 유니버스 규칙으로 재현한다.
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
          stages: [{ criterion: 'MARKET_CAP', limit: 1 }],
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

  it('경고가 없으면 null 이다 — 빈 배열이면 "컬럼이 생기기 전 job" 과 구분되지 않는다', () => {
    const job = ctx.container.jobQueue.enqueue(buildRequest());

    expect(ctx.container.jobQueue.getJob(job.id)!.submitWarningsJson).toBeNull();
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

  it('전략 버전을 실은 옛 화면의 제출도 받는다 (D-029)', async () => {
    // 배포로 전략 버전이 올라간 뒤, 그 전에 열어 둔 위저드가 보내는 형태.
    // 예전에는 "전략 버전 불일치" 400 이었다 — 사용자가 할 수 있는 일은 새로고침뿐이었다.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(), strategyVersion: LEGACY_VERSION },
    });
    expect(created.statusCode).toBe(201);

    // 보낸 값이 저장까지 새어 들어가면 안 된다 — 요청은 버전을 나르지 않는다
    const jobId = (created.json().job as { id: string }).id;
    const stored = JSON.parse(ctx.container.jobQueue.getJob(jobId)!.requestJson) as {
      strategyVersion?: string;
    };
    expect(stored.strategyVersion).toBeUndefined();
  });

  it('rebases a stored request that predates the current schema, and warns', async () => {
    // 구 스키마 형태: risk 없음, maxPositions 가 parameters 안에 있고, 전략 버전도 낮다
    const legacy = {
      ...buildRequest(),
      strategyVersion: LEGACY_VERSION,
      parameters: { ...buildRequest().parameters, maxPositions: 5 },
    } as Record<string, unknown>;
    delete legacy.risk;
    const job = ctx.container.jobQueue.enqueue(legacy as never);

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    // 복제는 §10 의 복구 경로다 — 스키마가 올라갔다고 막히면 안 된다
    expect(cloned.statusCode).toBe(201);
    const body = cloned.json() as { job: { id: string }; warnings: string[] };
    expect(body.warnings.some((w) => w.includes('maxPositions=5'))).toBe(true);
    expect(
      body.warnings.some(
        (w) => w.includes(LEGACY_VERSION) && w.includes(currentStrategyVersion(STRATEGY_ID)),
      ),
    ).toBe(true);

    // 재기준 결과가 실제로 현재 스키마를 만족해야 한다 — 전략 버전 필드는 사라진다 (D-029)
    const stored = JSON.parse(
      ctx.container.jobQueue.getJob(body.job.id)!.requestJson,
    ) as BacktestRequest & {
      parameters: Record<string, unknown>;
      strategyVersion?: string;
    };
    expect(stored.risk.maxPositions).toBe(5);
    expect(stored.strategyVersion).toBeUndefined();
    expect(stored.parameters.maxPositions).toBeUndefined();

    // 복제 경로도 같다 — rebase 경고와 검증 경고를 합쳐 저장한다
    const clonedStored = ctx.container.jobQueue.getJob(body.job.id)!;
    expect(JSON.parse(clonedStored.submitWarningsJson!)).toEqual(body.warnings);
  });

  it('clone에서 레거시 유니버스 규칙과 전략 리밸런싱 주기를 단계형 계약으로 승격한다', async () => {
    const legacy = {
      ...buildRequest(),
      parameters: { ...buildRequest().parameters, rebalanceMonths: 3 },
      universeRule: { markets: ['KOSPI'], sortKey: 'MKTCAP', topN: 200 },
      risk: { maxPositions: 40 },
    };
    const job = ctx.container.jobQueue.enqueue(legacy as never);
    registerSymbols(ctx.container, 'KR', ['000660']);
    await seedCorporateActionCoverage(ctx.container, ['000660'], ACTION_COVERAGE_YEARS);

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });

    expect(cloned.statusCode).toBe(201);
    const clonedJob = ctx.container.jobQueue.getJob((cloned.json() as { job: { id: string } }).job.id)!;
    const request = JSON.parse(clonedJob.requestJson) as BacktestRequest;
    expect(request.universeRule).toEqual({
      markets: ['KOSPI'],
      stages: [{ criterion: 'MARKET_CAP', limit: 200 }],
      rebalanceInterval: { value: 3, unit: 'MONTH' },
    });
    expect(request.parameters).not.toHaveProperty('rebalanceMonths');
    expect(JSON.parse(ctx.container.jobQueue.getJob(job.id)!.requestJson)).toMatchObject({
      universeRule: { markets: ['KOSPI'], sortKey: 'MKTCAP', topN: 200 },
      parameters: { rebalanceMonths: 3 },
    });
  });

  it('clone은 레거시 리밸런싱 주기가 없으면 1개월을 채우고 경고한다', async () => {
    const legacy = {
      ...buildRequest(),
      universeRule: { markets: ['KOSPI'], sortKey: 'MKTCAP', topN: 1 },
    };
    const job = ctx.container.jobQueue.enqueue(legacy as never);

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });

    expect(cloned.statusCode).toBe(201);
    const body = cloned.json() as { job: { id: string }; warnings: string[] };
    const request = JSON.parse(ctx.container.jobQueue.getJob(body.job.id)!.requestJson) as BacktestRequest;
    expect(request.universeRule.rebalanceInterval).toEqual({ value: 1, unit: 'MONTH' });
    expect(body.warnings.some((warning) => warning.includes('1개월'))).toBe(true);
  });

  it('refuses to clone a stored request that cannot be rebased (400, not 500)', async () => {
    const broken = { ...buildRequest() } as Record<string, unknown>;
    delete broken.period; // 기계적으로 되살릴 수 없는 편차
    const job = ctx.container.jobQueue.enqueue(broken as never);

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(400);
    expect((cloned.json() as { error: string }).error).toContain('복원할 수 없습니다');
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

  it('기간에 봉이 전혀 없는 제출을 제출 검증에서 거부한다 (D-025)', async () => {
    // 종목 마스터는 이 날짜를 커버하지만(coverage 는 넓은 고정 구간) 가격 데이터는
    // 2026-01-05 부터다 — 그보다 훨씬 앞선 구간은 확실히 0봉이다
    const noData = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(), period: { from: NO_CANDLE_DATE, to: '2020-12-31' } },
    });
    expect(noData.statusCode).toBe(400);
    const message = (noData.json() as { error: string }).error;
    // 진단이 커버리지로 이어지도록 보유 범위를 담는다
    expect(message).toContain('005930');
    expect(message).toContain('2026-01-05');
  });

  it('복제도 같은 제출 검증을 거친다 — 봉 없는 기간은 거부한다 (D-025)', async () => {
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(),
      period: { from: NO_CANDLE_DATE, to: '2020-12-31' },
    });

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(400);
    expect((cloned.json() as { error: string }).error).toContain('005930');
  });

  it('복제도 재무 요구 검증을 거친다 — 재무 없는 데이터셋의 밸류 전략은 422', async () => {
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
    expect(cloned.statusCode).toBe(422);
    expect((cloned.json() as { error: string }).error).toContain('상장시점 재무 데이터가 필요');
  });

  it('준비가 완료된 초안은 재무 요구 미충족도 blockers 에 담는다', async () => {
    const request: BacktestRequest = {
      ...buildRequest(),
      strategyId: 'value-quality-rank',
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
    };
    const job = ctx.container.jobQueue.enqueue(request);

    // 완료된 준비가 있어야 초안이 실제 union으로 재무 blockers 를 계산한다(리뷰
    // finding, 2026-08-09) — 준비 없이 유니버스를 추측하지 않는다.
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

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { blockers: string[] };
    expect(body.blockers.some((b) => b.includes('상장시점 재무 데이터가 필요'))).toBe(true);
  });

  /**
   * 리뷰 finding(2026-08-09): 완료된 준비가 없는 초안은 `UniverseRuleResolver.
   * resolve()`(stages[0] 하나만 시총으로 보는 stopgap)로 유니버스를 추측하지
   * 않는다. PER 을 첫 단계로 두면 그 stopgap이 기준을 완전히 무시하고 시총으로만
   * 뽑았을 잘못된 유니버스가 재무 blockers 에 들어갔을 것이다 — 지금은 준비가
   * 없으면 그 계산 자체를 건너뛰고 "데이터 준비 필요" 신호만 담는다.
   */
  it('여러 단계(PER 우선) 규칙의 초안은 준비 완료 전에는 유니버스를 추측하지 않는다', async () => {
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(),
      universeRule: {
        markets: ['KOSPI'],
        stages: [
          { criterion: 'PER', limit: 5 },
          { criterion: 'MARKET_CAP', limit: 1 },
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
    const body = draft.json() as { blockers: string[] };
    expect(body.blockers.some((b) => b.includes('데이터 준비'))).toBe(true);
    // 옛 stopgap이 살아 있었다면 미커버 리밸런스 날짜를 그릇된(시총 전용) 유니버스로
    // 판정해 이 문구를 냈을 것이다 — 이제는 그 경로를 아예 타지 않는다.
    expect(
      body.blockers.some((b) => b.includes('종목 마스터가 다음 리밸런스 날짜를 커버하지 않습니다')),
    ).toBe(false);
  });

  it('일부 종목만 봉이 없으면 거부하지 않는다 (신규 상장 등 정상)', async () => {
    // 종목을 하나 더 등록하고 topN 을 2로 올려 유니버스에 넣되 봉은 넣지 않는다 —
    // 커버리지 행이 없는 종목이 섞여도 제출은 통과해야 한다 (D-025)
    ctx.container.symbolService.addSymbol('000660', 'KR');
    // 000660 도 unionSymbols 에 들어오므로 자본변동 게이트도 통과해 둬야 한다
    await seedCorporateActionCoverage(ctx.container, ['000660'], ACTION_COVERAGE_YEARS);

    const partial = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(), universeRule: universeRule(2) },
    });
    expect(partial.statusCode).toBe(201);
  });

  it('초안은 재기준된 요청과 경고를 돌려준다 (재설정 및 복제)', async () => {
    const legacy = {
      ...buildRequest(),
      strategyVersion: LEGACY_VERSION,
      parameters: { ...buildRequest().parameters, maxPositions: 5 },
    } as Record<string, unknown>;
    delete legacy.risk;
    const job = ctx.container.jobQueue.enqueue(legacy as never);

    // 재기준된 요청 모양을 먼저 읽어(blockers 는 아직 무시) 그 값으로 준비를
    // 완료해 둔다 — 완료된 준비가 없으면 blockers 는 이제 "데이터 준비 필요" 로
    // 채워진다(리뷰 finding, 2026-08-09), 유니버스를 추측하지 않기 때문이다.
    const firstDraft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    const rebasedRequest = (firstDraft.json() as { request: BacktestRequest }).request;
    const preparation = ctx.container.backtestPreparationOrchestrator.start({
      universeRule: rebasedRequest.universeRule,
      period: rebasedRequest.period,
      strategyId: rebasedRequest.strategyId,
      parameters: rebasedRequest.parameters,
    });
    await waitFor(() => {
      const status = ctx.container.backtestPreparationOrchestrator.get(preparation.id)?.status;
      return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
    }, 5_000);
    expect(ctx.container.backtestPreparationOrchestrator.get(preparation.id)?.status).toBe('COMPLETED');

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as {
      request: BacktestRequest & { strategyVersion?: string };
      warnings: string[];
      blockers: string[];
    };
    expect(body.request.risk.maxPositions).toBe(5);
    // 초안은 버전을 나르지 않는다 (D-029). 다만 그때와 지금이 다르다는 사실은 경고로 남는다.
    expect(body.request.strategyVersion).toBeUndefined();
    expect(
      body.warnings.some(
        (w) => w.includes(LEGACY_VERSION) && w.includes(currentStrategyVersion(STRATEGY_ID)),
      ),
    ).toBe(true);
    expect(body.blockers).toEqual([]);
  });

  it('초안은 옛 잡의 봉 주기(1h·1m)를 일봉으로 재기준한다 (D-041, Critical 1)', async () => {
    // timeframe:'1d' 로 좁혀진 지금 스키마는 '1h' 를 거부한다.
    // 하지만 옛 잡은 여전히 '1h'·'1m' 로 저장돼 있다.
    // clone-draft 는 이걸 400 으로 끊지 않고 일봉으로 재기준해 화면을 열어줘야
    // 한다(stored-request.ts rebaseStoredRequest).
    const legacy = { ...buildRequest(), timeframe: '1h' } as Record<string, unknown>;
    const job = ctx.container.jobQueue.enqueue(legacy as never);

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as {
      request: BacktestRequest & { timeframe?: string };
      warnings: string[];
      blockers: string[];
    };
    expect(body.request.timeframe).toBe('1d');
    expect(body.warnings.some((w) => w.includes('1h') && w.includes('일봉'))).toBe(true);
  });

  it('초안은 제출 불가한 원본도 열어준다 — 사유는 blockers 에 담는다', async () => {
    // 봉이 없는 기간 → 제출은 400 이지만 초안은 열려야 고칠 수 있다
    const request: BacktestRequest = {
      ...buildRequest(),
      period: { from: NO_CANDLE_DATE, to: '2020-12-31' },
    };
    const job = ctx.container.jobQueue.enqueue(request);

    // 완료된 준비가 있어야 초안이 실제 union으로 캔들 존재 여부를 판정한다
    // (리뷰 finding, 2026-08-09) — 준비 없이 유니버스를 추측하지 않는다.
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

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { request: BacktestRequest; blockers: string[] };
    // 원본 값은 그대로 돌려준다 — 사용자가 이 값을 보고 고친다
    expect(body.request.period.from).toBe(NO_CANDLE_DATE);
    expect(body.blockers.some((b) => b.includes('005930'))).toBe(true);
  });

  it('초안은 없는 작업에 404, 되살릴 수 없는 요청에 400', async () => {
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/job_nope/clone-draft',
      cookies: { qp_session: cookie },
    });
    expect(missing.statusCode).toBe(404);

    const broken = { ...buildRequest() } as Record<string, unknown>;
    delete broken.period;
    const brokenJob = ctx.container.jobQueue.enqueue(broken as never);
    const brokenDraft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${brokenJob.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(brokenDraft.statusCode).toBe(400);
    expect((brokenDraft.json() as { error: string }).error).toContain('복원할 수 없습니다');
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
