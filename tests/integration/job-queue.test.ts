import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANCEL_SIGTERM_DELAY_MS } from '../../src/server/modules/backtest/application/job-orchestrator.js';
import { ENGINE_VERSION } from '../../src/server/modules/backtest/domain/engine.js';
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
    expect(body.run.engineVersion).toBe(ENGINE_VERSION);
    expect(body.run.strategyId).toBe('hourly-breakout');
    expect(body.run.feeModelVersion).toBe('kr-equity-default@1.1.0');
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
      const requestedAt = Date.now();
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
      const elapsedMs = Date.now() - requestedAt;

      const final = ctx.container.jobQueue.getJob(jobId)!;
      expect(final.status).toBe('CANCELLED');
      expect(final.error).toBeNull();
      // SIGTERM·SIGKILL 폴백도 결국 CANCELLED 로 끝나므로 상태만으로는 두 경로가 구분되지 않는다.
      // 신호가 나가기 전에 끝났다는 것이 IPC 경로로 취소됐다는 유일한 증거다.
      expect(elapsedMs).toBeLessThan(CANCEL_SIGTERM_DELAY_MS);
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

  it('rebases a stored request that predates the current schema, and warns', async () => {
    // 구 스키마 형태: risk 없음, maxPositions 가 parameters 안에 있고, 전략 버전도 낮다
    const legacy = {
      ...buildRequest(datasetId),
      strategyVersion: '1.1.0',
      parameters: { ...buildRequest(datasetId).parameters, maxPositions: 5 },
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
    expect(body.warnings.some((w) => w.includes('1.1.0') && w.includes('1.2.0'))).toBe(true);

    // 재기준 결과가 실제로 현재 스키마를 만족해야 한다
    const stored = JSON.parse(
      ctx.container.jobQueue.getJob(body.job.id)!.requestJson,
    ) as BacktestRequest & { parameters: Record<string, unknown> };
    expect(stored.risk.maxPositions).toBe(5);
    expect(stored.strategyVersion).toBe('1.2.0');
    expect(stored.parameters.maxPositions).toBeUndefined();
  });

  it('refuses to clone a stored request that cannot be rebased (400, not 500)', async () => {
    const broken = { ...buildRequest(datasetId) } as Record<string, unknown>;
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

  it('reports schema violations in Korean, not raw Zod English (M9 마무리)', async () => {
    const badBody = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(datasetId), capital: { initialCash: -1, currency: 'KRW' } },
    });
    expect(badBody.statusCode).toBe(400);
    const message = (badBody.json() as { error: string }).error;
    expect(message).toMatch(/[가-힣]/);
    expect(message).not.toMatch(/Too small|Invalid|expected/i);
  });

  it('기간에 봉이 전혀 없는 제출을 제출 검증에서 거부한다 (D-025)', async () => {
    // 데이터셋 봉은 2026-01-05 부터다 — 그보다 앞선 구간은 확실히 0봉이다
    const noData = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(datasetId), period: { from: '2020-01-01', to: '2020-12-31' } },
    });
    expect(noData.statusCode).toBe(400);
    const message = (noData.json() as { error: string }).error;
    // 진단이 커버리지로 이어지도록 보유 범위를 담는다
    expect(message).toContain('005930');
    expect(message).toContain('2026-01-05');
  });

  it('복제도 같은 제출 검증을 거친다 — 봉 없는 기간은 거부한다 (D-025)', async () => {
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(datasetId),
      period: { from: '2020-01-01', to: '2020-12-31' },
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
      ...buildRequest(datasetId),
      strategyId: 'value-quality-rank',
      strategyVersion: '1.0.0',
      parameters: { topN: 20, rebalanceMonths: 3, staleQuarters: 2 },
    });

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(422);
    expect((cloned.json() as { error: string }).error).toContain('상장시점 재무 데이터가 필요');
  });

  it('초안은 재무 요구 미충족도 blockers 에 담는다', async () => {
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(datasetId),
      strategyId: 'value-quality-rank',
      strategyVersion: '1.0.0',
      parameters: { topN: 20, rebalanceMonths: 3, staleQuarters: 2 },
    });

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { blockers: string[] };
    expect(body.blockers.some((b) => b.includes('상장시점 재무 데이터가 필요'))).toBe(true);
  });

  it('일부 종목만 봉이 없으면 거부하지 않는다 (신규 상장 등 정상)', async () => {
    // 심볼을 하나 더 데이터셋에 추가하되 봉은 넣지 않는다 — 커버리지 행이 없는 종목
    ctx.container.datasetService.updateSymbols(datasetId, { add: ['000660'] });

    const partial = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        ...buildRequest(datasetId),
        universe: { type: 'SYMBOLS', symbols: ['005930', '000660'] },
      },
    });
    expect(partial.statusCode).toBe(201);
  });

  it('초안은 재기준된 요청과 경고를 돌려준다 (재설정 및 복제)', async () => {
    const legacy = {
      ...buildRequest(datasetId),
      strategyVersion: '1.1.0',
      parameters: { ...buildRequest(datasetId).parameters, maxPositions: 5 },
    } as Record<string, unknown>;
    delete legacy.risk;
    const job = ctx.container.jobQueue.enqueue(legacy as never);

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as {
      request: BacktestRequest;
      warnings: string[];
      blockers: string[];
    };
    expect(body.request.risk.maxPositions).toBe(5);
    expect(body.request.strategyVersion).toBe('1.2.0');
    expect(body.warnings.some((w) => w.includes('1.1.0'))).toBe(true);
    expect(body.blockers).toEqual([]);
  });

  it('초안은 제출 불가한 원본도 열어준다 — 사유는 blockers 에 담는다', async () => {
    // 봉이 없는 기간 → 제출은 400 이지만 초안은 열려야 고칠 수 있다
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(datasetId),
      period: { from: '2020-01-01', to: '2020-12-31' },
    });

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { request: BacktestRequest; blockers: string[] };
    // 원본 값은 그대로 돌려준다 — 사용자가 이 값을 보고 고친다
    expect(body.request.period.from).toBe('2020-01-01');
    expect(body.blockers.some((b) => b.includes('005930'))).toBe(true);
  });

  it('초안은 없는 작업에 404, 되살릴 수 없는 요청에 400', async () => {
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/job_nope/clone-draft',
      cookies: { qp_session: cookie },
    });
    expect(missing.statusCode).toBe(404);

    const broken = { ...buildRequest(datasetId) } as Record<string, unknown>;
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
      const { username, password } = await createTestAdmin(small.container);
      const login = await small.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const smallCookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      await small.container.datasetService.importCsv({
        datasetName: 'kr-hourly-v1',
        market: 'KR',
        timeframe: '1h',
        symbol: '005930',
        fileName: 'trend.csv',
        csvContent: buildTrendingHourlyCsv(),
      });
      const smallDatasetId = small.container.datasetService.listDatasets()[0]!.id;
      const payload = buildRequest(smallDatasetId);

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
      payload: { ...buildRequest(datasetId), period: { from: '2026-03-31', to: '2026-01-05' } },
    });
    expect(inverted.statusCode).toBe(400);
    expect((inverted.json() as { error: string }).error).toContain('기간이 올바르지 않습니다');
  });
});
