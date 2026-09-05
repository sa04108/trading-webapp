import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAdmin, createTestApp, installPreparedSubmissionFixture, type TestApp } from '../helpers/test-app.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { PreparationReferenceService } from '../../src/server/modules/backtest/application/preparation-reference-service.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';

const request: BacktestRequest = {
  strategyId: 'range-breakout',
  parameters: {
    lookbackBars: 2,
    atrPeriod: 2,
    stopAtrMultiplier: 2,
    takeProfitAtrMultiplier: 3,
    riskPerTradePercent: 2,
  },
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
    rebalanceInterval: { unit: 'DAY', value: 1 },
  },
  period: { from: '2026-01-05', to: '2026-01-05' },
  capital: { initialCash: 10_000_000, currency: 'KRW' },
  execution: {
    fillTiming: 'NEXT_BAR_OPEN',
    commissionProfileId: 'kr-equity-default',
    slippageProfileId: 'fixed-5bps',
  },
  risk: { maxPositions: 5 },
  randomSeed: 42,
};

async function login(ctx: TestApp, username: string, password: string): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.find((item) => item.name === 'qp_session')!.value;
}

async function waitForPreparation(ctx: TestApp, id: string): Promise<void> {
  const started = Date.now();
  while (ctx.container.backtestPreparationOrchestrator.get(id)?.status !== 'COMPLETED') {
    const status = ctx.container.backtestPreparationOrchestrator.get(id)?.status;
    if (status === 'FAILED' || status === 'CANCELLED') throw new Error(`준비 실패: ${status}`);
    if (Date.now() - started > 5_000) throw new Error('준비 시간 초과');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('preparation reference lifecycle', () => {
  let ctx: TestApp;
  let cookie: string;
  let otherCookie: string;
  let userId: string;
  let rawInject: TestApp['app']['inject'];

  beforeEach(async () => {
    ctx = await createTestApp();
    const admin = await createTestAdmin(ctx.container);
    userId = (ctx.container.database.sqlite.prepare(
      'SELECT id FROM users WHERE username = ?',
    ).get(admin.username) as { id: string }).id;
    cookie = await login(ctx, admin.username, admin.password);
    const other = await createTestAdmin(ctx.container, {
      username: 'other-reference-user',
      password: 'different-correct-password',
    });
    otherCookie = await login(ctx, other.username, other.password);

    rawInject = ctx.app.inject.bind(ctx.app);
    installPreparedSubmissionFixture(ctx);
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [{
      standardCode: 'KR7005930003',
      shortCode: '005930',
      name: '삼성전자',
      market: 'KOSPI',
      marketCapKrw: '500000000000000',
    }, {
      standardCode: 'KR7000660001',
      shortCode: '000660',
      name: 'SK하이닉스',
      market: 'KOSPI',
      marketCapKrw: '100000000000000',
    }]);
    seedDailyBars(ctx.container.database.db, [{
      symbol: '005930',
      market: 'KR',
      timeframe: '1d',
      tsMs: Date.parse('2026-01-05T00:00:00Z'),
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1_000,
    }]);
    seedDailyBars(ctx.container.database.db, [{
      symbol: '000660',
      market: 'KR',
      timeframe: '1d',
      tsMs: Date.parse('2026-01-05T00:00:00Z'),
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1_000,
    }]);
    await seedCorporateActionCoverage(ctx.container, ['005930', '000660'], [2026]);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('preview ID만 초안에 저장하고 제출·복제에서 같은 준비 결과를 공유한다', async () => {
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: previewRequest,
    });
    expect(started.statusCode).toBe(202);
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);

    const ready = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: previewRequest,
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().preparationJobId).toBe(preparationId);

    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/universe',
      cookies: { qp_session: cookie },
      payload: { universeRule: request.universeRule, lastPreview: { preparationJobId: preparationId } },
    });
    expect(saved.statusCode).toBe(200);
    const rawDraft = ctx.container.database.sqlite.prepare(
      'SELECT payload_json FROM backtest_wizard_drafts WHERE user_id = ? AND context = ?',
    ).get(userId, '') as { payload_json: string };
    expect(JSON.parse(rawDraft.payload_json)).toEqual({ universeRule: request.universeRule });

    const loaded = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft/universe',
      cookies: { qp_session: cookie },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().draft.payload.lastPreview.result.preparationJobId).toBe(preparationId);

    const otherSaved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/universe',
      cookies: { qp_session: otherCookie },
      payload: { universeRule: request.universeRule, lastPreview: { preparationJobId: preparationId } },
    });
    expect(otherSaved.statusCode).toBe(200);
    expect(otherSaved.json().draft.payload.lastPreview).toBeNull();

    const submitted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: request,
    });
    expect(submitted.statusCode).toBe(201);
    const jobId = submitted.json<{ job: { id: string } }>().job.id;
    expect(ctx.container.jobQueue.getJob(jobId)?.preparationJobId).toBe(preparationId);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM preparation_wizard_references WHERE user_id = ?',
    ).get(userId)).toEqual({ count: 0 });
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM backtest_wizard_drafts WHERE user_id = ?',
    ).get(userId)).toEqual({ count: 0 });

    const clone = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${jobId}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(clone.statusCode).toBe(201);
    const cloneId = clone.json<{ job: { id: string } }>().job.id;
    expect(ctx.container.jobQueue.getJob(cloneId)?.preparationJobId).toBe(preparationId);

    const sourceStrategyDraft = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/backtests/wizard-draft/strategy?sourceJobId=${jobId}`,
      cookies: { qp_session: cookie },
      payload: {
        strategyId: request.strategyId,
        parameters: Object.fromEntries(Object.entries(request.parameters).map(([key, value]) => [key, String(value)])),
        currentStep: 'review',
      },
    });
    expect(sourceStrategyDraft.statusCode).toBe(200);

    const secondClone = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${jobId}/clone-configured`,
      cookies: { qp_session: cookie },
      payload: request,
    });
    expect(secondClone.statusCode).toBe(201);
    const secondCloneId = secondClone.json<{ job: { id: string } }>().job.id;
    expect(ctx.container.jobQueue.getJob(secondCloneId)?.preparationJobId).toBe(preparationId);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM backtest_wizard_drafts WHERE user_id = ? AND context = ?',
    ).get(userId, jobId)).toEqual({ count: 0 });

    for (const id of [jobId, cloneId, secondCloneId]) {
      expect(ctx.container.jobQueue.setStatus(id, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    }
    const deleteSource = await ctx.app.inject({
      method: 'DELETE', url: `/api/v1/backtests/${jobId}`, cookies: { qp_session: cookie },
    });
    expect(deleteSource.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId)).toEqual({ id: preparationId });

    const deleteClone = await ctx.app.inject({
      method: 'DELETE', url: `/api/v1/backtests/${cloneId}`, cookies: { qp_session: cookie },
    });
    expect(deleteClone.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId)).toEqual({ id: preparationId });

    const deleteLast = await ctx.app.inject({
      method: 'DELETE', url: `/api/v1/backtests/${secondCloneId}`, cookies: { qp_session: cookie },
    });
    expect(deleteLast.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId)).toBeUndefined();
  });

  it('같은 hash의 최신 준비가 있어도 원본 clone은 고정된 preparation을 재사용한다', async () => {
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: previewRequest,
    });
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: previewRequest,
    });
    const submitted = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: request,
    });
    expect(submitted.statusCode).toBe(201);
    const sourceId = submitted.json<{ job: { id: string } }>().job.id;
    const sourcePrep = ctx.container.database.sqlite.prepare(`
      SELECT request_hash, request_json, preview_json, created_at_ms, updated_at_ms
      FROM backtest_preparation_jobs WHERE id = ?
    `).get(preparationId) as {
      request_hash: string; request_json: string; preview_json: string;
      created_at_ms: number; updated_at_ms: number;
    };
    const newerPreview = {
      ...JSON.parse(sourcePrep.preview_json), warnings: ['newer candidate'], preparationJobId: 'prep_newer',
    };
    ctx.container.database.sqlite.prepare(`
      INSERT INTO backtest_preparation_jobs
        (id, request_hash, request_json, status, phase, preview_json, lifecycle_managed,
         created_at_ms, updated_at_ms, completed_at_ms)
      VALUES ('prep_newer', ?, ?, 'COMPLETED', 'FINALIZING', ?, 1, ?, ?, ?)
    `).run(
      sourcePrep.request_hash, sourcePrep.request_json, JSON.stringify(newerPreview),
      sourcePrep.created_at_ms + 100, sourcePrep.updated_at_ms + 100, sourcePrep.updated_at_ms + 100,
    );
    const otherId = (ctx.container.database.sqlite.prepare(
      'SELECT id FROM users WHERE username = ?',
    ).get('other-reference-user') as { id: string }).id;
    new PreparationReferenceService(ctx.container.database).bindWizard(otherId, '', 'prep_newer');

    const resolver = vi.spyOn(ctx.container.backtestPreparationOrchestrator, 'getReadyPreviewForWizard')
      .mockImplementation(() => { throw new Error('clone이 resolver를 호출했습니다'); });
    const cloned = await rawInject({
      method: 'POST', url: `/api/v1/backtests/${sourceId}/clone`, cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(201);
    const cloneId = cloned.json<{ job: { id: string } }>().job.id;
    expect(ctx.container.jobQueue.getJob(cloneId)?.preparationJobId).toBe(preparationId);
    expect(ctx.container.jobQueue.getJob(cloneId)?.universeScheduleJson)
      .toBe(ctx.container.jobQueue.getJob(sourceId)?.universeScheduleJson);
    expect(resolver).not.toHaveBeenCalled();

    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    const deleted = await ctx.app.inject({
      method: 'DELETE', url: `/api/v1/backtests/${sourceId}`, cookies: { qp_session: cookie },
    });
    expect(deleted.statusCode).toBe(204);
    const cloneAgain = await rawInject({
      method: 'POST', url: `/api/v1/backtests/${cloneId}/clone`, cookies: { qp_session: cookie },
    });
    expect(cloneAgain.statusCode).toBe(201);
  });

  it('미리보기 소유권이 없는 사용자의 제출을 자동 준비 fixture 없이 거부한다', async () => {
    const preview = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: {
        universeRule: request.universeRule,
        period: request.period,
        strategyId: request.strategyId,
        parameters: request.parameters,
      },
    });
    expect(preview.statusCode).toBe(202);
    const preparationId = preview.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: {
        universeRule: request.universeRule,
        period: request.period,
        strategyId: request.strategyId,
        parameters: request.parameters,
      },
    });

    const rejected = await rawInject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: otherCookie }, payload: request,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<{ error: string }>().error).toBe('PREPARATION_REQUIRED');
  });

  it('enqueue 직전 원본 데이터가 바뀌면 준비 필요 응답과 소유권을 보존한다', async () => {
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: previewRequest,
    });
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: previewRequest,
    });

    const queue = ctx.container.jobQueue;
    const originalEnqueue = queue.enqueue.bind(queue);
    vi.spyOn(queue, 'enqueue').mockImplementation((...args: Parameters<typeof originalEnqueue>) => {
      ctx.container.database.sqlite.prepare(
        "UPDATE symbols SET name = 'changed during enqueue' WHERE code = '005930'",
      ).run();
      return originalEnqueue(...args);
    });
    const rejected = await rawInject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: request,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<{ error: string }>().error).toBe('PREPARATION_REQUIRED');
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM preparation_wizard_references WHERE user_id = ?',
    ).get(userId)).toEqual({ count: 1 });
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM backtest_jobs',
    ).get()).toEqual({ count: 0 });
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId)).toEqual({ id: preparationId });
  });

  it('초안 교체와 삭제는 이전 terminal 준비를 수집하고 다른 사용자 참조는 보존한다', async () => {
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: previewRequest,
    });
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: previewRequest,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: otherCookie },
      payload: previewRequest,
    });

    const fake = await ctx.app.inject({
      method: 'PUT', url: '/api/v1/backtests/wizard-draft/universe', cookies: { qp_session: cookie },
      payload: { universeRule: request.universeRule, lastPreview: { preparationJobId: 'prep_fake' } },
    });
    expect(fake.statusCode).toBe(200);
    expect(fake.json().draft.payload.lastPreview.result.preparationJobId).toBe(preparationId);

    const replacementRequest = {
      ...previewRequest,
      universeRule: {
        ...previewRequest.universeRule,
        stages: [{ criterion: 'MARKET_CAP' as const, direction: 'HIGH' as const, limit: 2 }],
      },
    };
    const replacementStarted = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: replacementRequest,
    });
    expect(replacementStarted.statusCode).toBe(202);
    const replacementId = replacementStarted.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, replacementId);
    const replacementReady = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: replacementRequest,
    });
    expect(replacementReady.statusCode).toBe(200);
    expect(replacementReady.json().preparationJobId).toBe(replacementId);
    expect(replacementId).not.toBe(preparationId);
    const otherId = (ctx.container.database.sqlite.prepare(
      'SELECT id FROM users WHERE username = ?',
    ).get('other-reference-user') as { id: string }).id;
    expect(ctx.container.database.sqlite.prepare(
      'SELECT user_id AS userId, preparation_job_id AS preparationJobId FROM preparation_wizard_references ORDER BY user_id',
    ).all()).toEqual([
      { userId, preparationJobId: replacementId },
      { userId: otherId, preparationJobId: preparationId },
    ]);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM backtest_preparation_jobs WHERE id IN (?, ?)',
    ).get(preparationId, replacementId)).toEqual({ count: 2 });
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM preparation_preview_cache WHERE job_id IN (?, ?)',
    ).get(preparationId, replacementId)).toEqual({ count: 2 });

    const otherCleared = await ctx.app.inject({
      method: 'DELETE', url: '/api/v1/backtests/wizard-draft?all=true', cookies: { qp_session: otherCookie },
    });
    expect(otherCleared.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId)).toBeUndefined();
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(replacementId)).toEqual({ id: replacementId });

    const finalCleared = await ctx.app.inject({
      method: 'DELETE', url: '/api/v1/backtests/wizard-draft', cookies: { qp_session: cookie },
    });
    expect(finalCleared.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(replacementId)).toBeUndefined();
    expect(ctx.container.database.sqlite.prepare(
      'SELECT job_id FROM preparation_preview_cache WHERE job_id IN (?, ?)',
    ).all(preparationId, replacementId)).toEqual([]);
  });

  it('enqueue 실패는 wizard 참조와 초안을 같은 트랜잭션으로 보존한다', async () => {
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: previewRequest,
    });
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { qp_session: cookie },
      payload: previewRequest,
    });
    await ctx.app.inject({
      method: 'PUT', url: '/api/v1/backtests/wizard-draft/universe', cookies: { qp_session: cookie },
      payload: { universeRule: request.universeRule, lastPreview: { preparationJobId: preparationId } },
    });
    ctx.container.database.sqlite.exec(`
      CREATE TRIGGER fail_reference_test_enqueue
      BEFORE INSERT ON backtest_jobs
      BEGIN SELECT RAISE(ABORT, 'forced enqueue failure'); END;
    `);

    const failed = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload: request,
    });
    expect(failed.statusCode).toBe(500);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM preparation_wizard_references WHERE user_id = ?',
    ).get(userId)).toEqual({ count: 1 });
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM backtest_wizard_drafts WHERE user_id = ?',
    ).get(userId)).toEqual({ count: 1 });
    expect(ctx.container.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM backtest_jobs',
    ).get()).toEqual({ count: 0 });
  });
});
