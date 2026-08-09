import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PreparationInput } from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';
import { dailySelectionMetrics } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedCorporateActionCoverage, seedDailyBars } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

const previewInput = (criterion: 'MARKET_CAP' | 'PER' = 'MARKET_CAP'): PreparationInput => ({
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion, limit: 1 }],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  },
  period: { from: '2026-01-05', to: '2026-01-05' },
  strategyId: 'range-breakout',
  parameters: {},
});

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() - started > 2_000) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('backtest preparation HTTP/SSE', () => {
  let ctx: TestApp;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    const credentials = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: credentials,
    });
    cookie = login.cookies.find((item) => item.name === 'qp_session')!.value;
  });

  afterEach(async () => {
    await ctx.close();
  });

  const seedReadyUniverse = (entries = [{
    standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자',
    market: 'KOSPI' as const, marketCapKrw: '500000000000000',
  }]) => seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], entries);

  it('준비가 필요하면 202 job을 주고 완료된 같은 hash는 재확인 후 200 preview를 준다', async () => {
    seedReadyUniverse();

    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie }, payload: previewInput(),
    });

    expect(started.statusCode).toBe(202);
    const id = started.json<{ job: { id: string; status: string } }>().job.id;
    await waitFor(
      () => ctx.container.backtestPreparationOrchestrator.get(id),
      (job) => job?.status === 'COMPLETED',
    );

    const ready = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie }, payload: previewInput(),
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      schedule: [{ members: [{ symbol: '005930' }] }],
      unionSymbols: ['005930'],
      stages: [{ criterion: 'MARKET_CAP', limit: 1 }],
    });
  });

  it('같은 request hash라도 resolver schedule이 달라졌으면 완료 결과를 재사용하지 않는다', async () => {
    seedReadyUniverse([
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '200' },
      { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSPI', marketCapKrw: '100' },
    ]);
    const first = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie }, payload: previewInput(),
    });
    const firstId = first.json<{ job: { id: string } }>().job.id;
    await waitFor(
      () => ctx.container.backtestPreparationOrchestrator.get(firstId),
      (job) => job?.status === 'COMPLETED',
    );

    ctx.container.database.db.update(dailySelectionMetrics)
      .set({ marketCapKrw: '300' })
      .where(eq(dailySelectionMetrics.standardCode, 'KR7000660001'))
      .run();

    const changed = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie }, payload: previewInput(),
    });
    expect(changed.statusCode).toBe(202);
    expect(changed.json<{ job: { id: string } }>().job.id).not.toBe(firstId);
  });

  it('백테스트 제출은 같은 hash 준비 전 409이고 완료 뒤 staged schedule을 그대로 pin한다', async () => {
    seedReadyUniverse();
    const preparation = {
      ...previewInput(),
      universeRule: {
        ...previewInput().universeRule,
        rebalanceInterval: { unit: 'DAY' as const, value: 1 },
      },
    };
    const request = {
      ...preparation,
      timeframe: '1d',
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
      },
      risk: { maxPositions: 5 },
      randomSeed: 42,
    };

    const blocked = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests',
      cookies: { qp_session: cookie }, payload: request,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: string }>().error).toBe('PREPARATION_REQUIRED');

    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie }, payload: preparation,
    });
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitFor(
      () => ctx.container.backtestPreparationOrchestrator.get(preparationId),
      (job) => job?.status === 'COMPLETED',
    );
    seedDailyBars(ctx.container.database.db, [{
      symbol: '005930', market: 'KR', timeframe: '1d',
      tsMs: Date.parse('2026-01-05T00:00:00Z'),
      open: 100, high: 110, low: 90, close: 105, volume: 1_000,
    }]);
    seedCorporateActionCoverage(ctx.container, ['005930'], [2026]);

    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests',
      cookies: { qp_session: cookie }, payload: request,
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json<{ job: { id: string } }>().job.id;
    const stored = ctx.container.jobQueue.getJob(jobId)!;
    expect(JSON.parse(stored.universeScheduleJson)).toEqual([{
      rebalanceDate: '2026-01-05',
      effectiveTradingDate: '2026-01-05',
      symbols: ['005930'],
      excludedNonTradingCount: 0,
    }]);
  });

  it('GET snapshot은 status·phase·progress·nextResumeAtMs를 반환한다', async () => {
    seedReadyUniverse();
    const id = ctx.container.backtestPreparationOrchestrator.start(previewInput()).id;

    const response = await ctx.app.inject({
      method: 'GET', url: `/api/v1/backtests/preparation-jobs/${id}`,
      cookies: { qp_session: cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ job: expect.objectContaining({
      id,
      status: expect.any(String),
      phase: expect.any(String),
      doneSymbols: expect.any(Number),
      totalSymbols: expect.any(Number),
      savedFacts: expect.any(Number),
      gapCount: expect.any(Number),
      nextResumeAtMs: null,
    }) });
  });

  it('SSE는 첫 terminal snapshot을 즉시 전송하고 연결을 닫는다', async () => {
    seedReadyUniverse();
    const id = ctx.container.backtestPreparationOrchestrator.start(previewInput()).id;
    await waitFor(
      () => ctx.container.backtestPreparationOrchestrator.get(id),
      (job) => job?.status === 'COMPLETED',
    );

    const response = await ctx.app.inject({
      method: 'GET', url: `/api/v1/backtests/preparation-jobs/${id}/events`,
      cookies: { qp_session: cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain(`\"id\":\"${id}\"`);
    expect(response.body).toContain('\"status\":\"COMPLETED\"');
  });

  it('SSE initial 조회 직후 terminal이 된 race도 최신 snapshot을 보내고 닫는다', async () => {
    seedReadyUniverse();
    const orchestrator = ctx.container.backtestPreparationOrchestrator;
    const id = orchestrator.start(previewInput()).id;
    await waitFor(() => orchestrator.get(id), (job) => job?.status === 'COMPLETED');

    const originalGet = orchestrator.get.bind(orchestrator);
    let staleInitialRead = true;
    orchestrator.get = ((jobId: string) => {
      const actual = originalGet(jobId);
      if (staleInitialRead && actual) {
        staleInitialRead = false;
        return { ...actual, status: 'RUNNING' as const };
      }
      return actual;
    }) as typeof orchestrator.get;

    const response = await ctx.app.inject({
      method: 'GET', url: `/api/v1/backtests/preparation-jobs/${id}/events`,
      cookies: { qp_session: cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('\"status\":\"COMPLETED\"');
  });

  it('cancel은 idempotent하고 job을 terminal CANCELLED로 만든다', async () => {
    seedReadyUniverse();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = ctx.container.universeRuleResolver.resolveOrDescribeNeeds.bind(ctx.container.universeRuleResolver);
    ctx.container.universeRuleResolver.resolveOrDescribeNeeds = async (...args) => {
      await gate;
      return original(...args);
    };
    const id = ctx.container.backtestPreparationOrchestrator.start(previewInput()).id;
    await waitFor(
      () => ctx.container.backtestPreparationOrchestrator.get(id),
      (job) => job?.status === 'RUNNING',
    );

    const first = await ctx.app.inject({
      method: 'POST', url: `/api/v1/backtests/preparation-jobs/${id}/cancel`,
      cookies: { qp_session: cookie },
    });
    const second = await ctx.app.inject({
      method: 'POST', url: `/api/v1/backtests/preparation-jobs/${id}/cancel`,
      cookies: { qp_session: cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    release();
    await waitFor(
      () => ctx.container.backtestPreparationOrchestrator.get(id),
      (job) => job?.status === 'CANCELLED',
    );
  });

  it('DART key가 없으면 PER 후보 재무 동기화가 필요한 요청만 503이다', async () => {
    seedReadyUniverse();

    const response = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie }, payload: previewInput('PER'),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>().error).toMatch(/DART/);
  });

  it('최종 유니버스가 0이면 FAILED와 사용자용 한국어 원인을 남긴다', async () => {
    seedReadyUniverse([]);
    const response = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie }, payload: previewInput(),
    });
    expect(response.statusCode).toBe(202);
    const id = response.json<{ job: { id: string } }>().job.id;

    const failed = await waitFor(
      () => ctx.container.backtestPreparationOrchestrator.get(id),
      (job) => job?.status === 'FAILED',
    );
    expect(failed?.error).toMatch(/선정된 종목|유니버스/);
  });
});
