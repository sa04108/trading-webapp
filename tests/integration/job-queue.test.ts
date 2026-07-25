import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * 평일 30일 × 7봉 1시간봉 CSV (KST 09:00 = UTC 00:00).
 * 상승(돌파 진입) → 급락(손절 청산) → 재상승(재진입) 국면으로
 * 완결 거래가 반드시 생기도록 구성한다.
 */
function buildTrendingHourlyCsv(): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  let tradingDays = 0;
  let dayCursor = Date.UTC(2026, 0, 5); // 2026-01-05 (월)

  const baseForDay = (day: number): number => {
    if (day < 15) return 100 + day * 5; // 상승: 100 → 170
    if (day < 23) return 170 - (day - 14) * 6; // 급락: 170 → 122
    return 122 + (day - 22) * 5; // 재상승
  };

  while (tradingDays < 30) {
    const dayOfWeek = new Date(dayCursor).getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const base = baseForDay(tradingDays);
      for (let barIndex = 0; barIndex < 7; barIndex += 1) {
        const ts = dayCursor + barIndex * HOUR;
        const open = base + barIndex * 0.3;
        const close = open + 0.5;
        const high = close + 0.1;
        const low = open - 0.6;
        lines.push(`${ts},${open},${high},${low},${close},1000`);
      }
      tradingDays += 1;
    }
    dayCursor += DAY;
  }
  return lines.join('\n');
}

function buildRequest(datasetId: string): BacktestRequest {
  return {
    strategyId: 'hourly-breakout',
    strategyVersion: '1.2.0',
    parameters: {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      riskPerTradePercent: 2,
    },
    datasetId,
    universe: { type: 'SYMBOLS', symbols: ['005930'] },
    period: { from: '2026-01-05', to: '2026-03-31' },
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
  let datasetId: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    await ctx.container.datasetService.importCsv({
      datasetName: 'kr-hourly-v1',
      market: 'KR',
      timeframe: '1h',
      symbol: '005930',
      fileName: 'trend.csv',
      csvContent: buildTrendingHourlyCsv(),
    });
    datasetId = ctx.container.datasetService.listDatasets()[0]!.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('runs a backtest end-to-end in a child process', { timeout: 90_000 }, async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(datasetId),
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
    expect(body.run.engineVersion).toBe('1.1.0');
    expect(body.run.strategyId).toBe('hourly-breakout');
    expect(body.run.feeModelVersion).toBe('kr-equity-default@1.0.0');
    expect(body.run.randomSeed).toBe(42);
    expect(body.run.datasetHash).not.toBe('unknown');
    // 제출 시점에 고정된 데이터셋 버전이 그대로 기록돼야 한다 (재현성 §9.5)
    const pinned = ctx.container.datasetService.getLatestVersion(datasetId)!;
    expect(body.run.datasetVersion).toBe(pinned.version);
    expect(body.run.datasetHash).toBe(pinned.contentHash);
    expect(typeof body.metrics.totalReturnPct).toBe('number');
    expect(body.metrics.tradeCount as number).toBeGreaterThan(0);

    // 거래 내역
    const trades = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}/trades`,
      cookies: { qp_session: cookie },
    });
    expect((trades.json().trades as unknown[]).length).toBeGreaterThan(0);

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
    expect(seriesBody.totalEquityPoints).toBe(210); // 30일 × 7봉

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
    expect((exported.json() as { equityPoints: unknown[] }).equityPoints).toHaveLength(210);

    // clone → 새 QUEUED 작업
    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${jobId}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(201);
    expect(cloned.json().job.status).toBe('QUEUED');
  });

  it('claims jobs atomically in FIFO order', () => {
    const queue = ctx.container.jobQueue;
    const first = queue.enqueue(buildRequest(datasetId));
    const second = queue.enqueue(buildRequest(datasetId));

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
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: buildRequest(datasetId),
      });
      const jobId = (created.json().job as { id: string }).id;

      // 자식 프로세스 기동 직후(STARTING) 취소 — IPC 로 전달되어 CANCELLED 로 끝나야 한다
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
    },
  );

  it('cancels a QUEUED job immediately', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(datasetId),
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

  it('never regresses a terminal status via late progress or status writes (C1)', () => {
    const queue = ctx.container.jobQueue;
    const job = queue.enqueue(buildRequest(datasetId));
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
    const job = queue.enqueue(buildRequest(datasetId));
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
    const job = queue.enqueue(buildRequest(datasetId));
    queue.setStatus(job.id, 'RUNNING', { pid: 999_999_999 });

    const recovered = queue.recoverInterrupted(() => false);
    expect(recovered).toContain(job.id);
    expect(queue.getJob(job.id)!.status).toBe('INTERRUPTED');
    expect(queue.getJob(job.id)!.error).toContain('복제');
  });

  it('refuses to delete non-terminal jobs', async () => {
    const queue = ctx.container.jobQueue;
    const job = queue.enqueue(buildRequest(datasetId));

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
      payload: { ...buildRequest(datasetId), strategyId: 'nope' },
    });
    expect(badStrategy.statusCode).toBe(400);

    const badDataset = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest('ds_nope'),
    });
    expect(badDataset.statusCode).toBe(400);

    const badSymbol = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        ...buildRequest(datasetId),
        universe: { type: 'SYMBOLS', symbols: ['005930', '005935'] }, // 005935 는 데이터셋에 없음
      },
    });
    expect(badSymbol.statusCode).toBe(400);
    expect((badSymbol.json() as { error: string }).error).toContain('005935');

    const badParams = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        ...buildRequest(datasetId),
        parameters: { lookbackBars: 9_999 },
      },
    });
    expect(badParams.statusCode).toBe(400);
  });
});
