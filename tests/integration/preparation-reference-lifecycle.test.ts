import { describe, expect, vi } from 'vitest';
import { createTestAdmin, type TestApp } from '../helpers/test-app.js';
import { authenticatedTest as base } from '../helpers/test-fixtures.js';
import { installEmptyDartSyncStub } from '../helpers/backtest-preparation-stubs.js';
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
  return response.cookies.find((item) => item.name === 'session')!.value;
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
  type Scenario = { ctx: TestApp; cookie: string; otherCookie: string; userId: string };
  const it = base.extend<{ scenario: Scenario }>({
    scenario: async ({ ctx, admin, cookie }, use) => {
      const restoreDart = installEmptyDartSyncStub(ctx);
      const userId = (ctx.container.database.sqlite.prepare(
        'SELECT id FROM users WHERE username = ?',
      ).get(admin.username) as { id: string }).id;
      const other = await createTestAdmin(ctx.container, {
        username: 'other-reference-user',
        password: 'different-correct-password',
      });
      const otherCookie = await login(ctx, other.username, other.password);
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
      }], [{ startDate: '2024-11-17', endDate: '2026-01-05' }]);
      for (const symbol of ['005930', '000660']) {
        seedDailyBars(ctx.container.database.db, [{
          symbol,
          market: 'KR',
          timeframe: '1d',
          tsMs: Date.parse('2026-01-05T00:00:00Z'),
          open: 100,
          high: 110,
          low: 90,
          close: 105,
          volume: 1_000,
        }]);
      }
      await seedCorporateActionCoverage(ctx.container, ['005930', '000660'], [2026]);
      try {
        await use({ ctx, cookie, otherCookie, userId });
      } finally {
        await ctx.close();
        restoreDart();
      }
    },
  });

  // 기존 단일 문맥 제출 검사는 서로 다른 위저드의 공유 미리보기와 동시 중복 제출을 보호하지 못한다.
  it('두 위저드가 같은 미리보기로 독립 제출하고 같은 위저드의 중복 제출은 원자적으로 거부한다', async ({ scenario }) => {
    const { ctx, cookie, userId } = scenario;
    const a = ctx.container.backtestWizardService.create(userId);
    const b = ctx.container.backtestWizardService.create(userId);
    const preview = (wizardId: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview',
      cookies: { session: cookie }, payload: { wizardId, universeRule: request.universeRule, period: request.period, strategyId: request.strategyId, parameters: request.parameters } });
    const started = await preview(a.id);
    expect(started.statusCode).toBe(202);
    const preparationId = started.json().job.id;
    await waitForPreparation(ctx, preparationId);
    expect((await preview(b.id)).statusCode).toBe(200);
    const submit = (id: string) => ctx.app.inject({ method: 'POST', url: `/api/v1/backtests?wizardId=${id}`, cookies: { session: cookie }, payload: request });
    const duplicate = await Promise.all([submit(a.id), submit(a.id)]);
    expect(duplicate.map((response) => response.statusCode).sort()).toEqual([201,409]);
    const second = await submit(b.id);
    expect(second.statusCode, second.body).toBe(201);
    const firstId = duplicate.find((response) => response.statusCode === 201)!.json().job.id;
    const secondId = second.json().job.id;
    expect(firstId).not.toBe(secondId);
    for (const id of [firstId,secondId]) expect(ctx.container.jobQueue.getJob(id)?.preparationJobId).toBe(preparationId);
    expect(ctx.container.database.sqlite.prepare('SELECT count(*) AS count FROM backtest_jobs').get()).toEqual({ count: 2 });
    expect(ctx.container.backtestWizardService.get(userId,a.id)).toMatchObject({ status: 'QUEUED', backtestJobId: firstId, link: `/backtests/${firstId}` });
    expect(ctx.container.backtestWizardService.get(userId,b.id)).toMatchObject({ status: 'QUEUED', backtestJobId: secondId });
    const jobs = (await ctx.app.inject({ method: 'GET', url: '/api/v1/jobs', cookies: { session: cookie } })).json().jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job: { kind: string }) => job.kind === 'backtest-wizard')).toBe(true);
  });

  it('preview ID만 초안에 저장하고 제출·복제에서 같은 준비 결과를 공유한다', async ({ scenario }) => {
    const { ctx, cookie, otherCookie, userId } = scenario;
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { session: cookie },
      payload: previewRequest,
    });
    expect(started.statusCode).toBe(202);
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);

    const ready = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { session: cookie },
      payload: previewRequest,
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().preparationJobId).toBe(preparationId);

    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/universe',
      cookies: { session: cookie },
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
      cookies: { session: cookie },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().draft.payload.lastPreview.result.preparationJobId).toBe(preparationId);

    // 초안 조회에서도 현재 전략 및 미리보기 검증 버전이 바뀐 결과는 재사용하지 않는다.
    const db = ctx.container.database.sqlite;
    const receipt = db.prepare('SELECT * FROM preparation_preview_cache WHERE job_id = ?').get(preparationId) as { job_id: string; data_revision: number; validation_version: string; fundamental_symbols_json: string };
    const restoreReceipt = () => db.prepare('INSERT INTO preparation_preview_cache VALUES (?, ?, ?, ?)').run(receipt.job_id, receipt.data_revision, receipt.validation_version, receipt.fundamental_symbols_json);
    const job = db.prepare('SELECT request_hash AS hash FROM backtest_preparation_jobs WHERE id = ?').get(preparationId) as { hash: string };
    const loadDraft = () => ctx.app.inject({ method: 'GET', url: '/api/v1/backtests/wizard-draft/universe', cookies: { session: cookie } });
    const assertStale = async () => {
      const response = await loadDraft();
      expect(response.statusCode).toBe(200);
      expect(response.json().draft.payload).toEqual({ universeRule: request.universeRule, lastPreview: null });
    };
    db.prepare('UPDATE preparation_preview_cache SET validation_version = ? WHERE job_id = ?').run('old-version', preparationId);
    await assertStale();
    db.prepare('UPDATE preparation_preview_cache SET validation_version = ? WHERE job_id = ?').run(receipt.validation_version, preparationId);
    db.prepare('UPDATE backtest_preparation_jobs SET request_hash = ? WHERE id = ?').run('old-strategy-hash', preparationId);
    restoreReceipt();
    await assertStale();
    db.prepare('UPDATE backtest_preparation_jobs SET request_hash = ? WHERE id = ?').run(job.hash, preparationId);
    restoreReceipt();
    expect((await loadDraft()).json().draft.payload.lastPreview.result.preparationJobId).toBe(preparationId);

    const otherSaved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/universe',
      cookies: { session: otherCookie },
      payload: { universeRule: request.universeRule, lastPreview: { preparationJobId: preparationId } },
    });
    expect(otherSaved.statusCode).toBe(200);
    expect(otherSaved.json().draft.payload.lastPreview).toBeNull();

    const submitted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { session: cookie },
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
      cookies: { session: cookie },
    });
    expect(clone.statusCode).toBe(201);
    const cloneId = clone.json<{ job: { id: string } }>().job.id;
    expect(ctx.container.jobQueue.getJob(cloneId)?.preparationJobId).toBe(preparationId);

    const sourceStrategyDraft = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/backtests/wizard-draft/strategy?sourceJobId=${jobId}`,
      cookies: { session: cookie },
      payload: {
        strategyId: request.strategyId,
        parameters: Object.fromEntries(Object.entries(request.parameters).map(([key, value]) => [key, String(value)])),
        currentStep: 'review',
      },
    });
    expect(sourceStrategyDraft.statusCode).toBe(200);

    // 복제 미리보기 참조를 최초 연결해도 사용자가 저장한 검토 단계는 유지한다.
    const wizard = ctx.container.backtestWizardService.create(userId, jobId);
    const wizardDraftUrl = `/api/v1/backtests/wizard-draft`;
    const strategySaved = await ctx.app.inject({
      method: 'PUT', url: `${wizardDraftUrl}/strategy?wizardId=${wizard.id}`, cookies: { session: cookie },
      payload: { strategyId: request.strategyId, parameters: Object.fromEntries(Object.entries(request.parameters).map(([key, value]) => [key, String(value)])), currentStep: 'review' },
    });
    expect(strategySaved.statusCode).toBe(200);
    const universeSaved = await ctx.app.inject({
      method: 'PUT', url: `${wizardDraftUrl}/universe?wizardId=${wizard.id}`, cookies: { session: cookie },
      payload: { universeRule: request.universeRule, lastPreview: { preparationJobId: preparationId } },
    });
    expect(universeSaved.statusCode).toBe(200);
    expect(universeSaved.json().draft.payload.lastPreview.result.preparationJobId).toBe(preparationId);
    expect(ctx.container.backtestWizardService.get(userId, wizard.id)).toMatchObject({
      currentStep: 'review', link: `/backtests/new/review?wizard=${wizard.id}`,
    });
    ctx.container.backtestWizardService.cancel(userId, wizard.id);

    const secondClone = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${jobId}/clone-configured`,
      cookies: { session: cookie },
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
      method: 'DELETE', url: `/api/v1/backtests/${jobId}`, cookies: { session: cookie },
    });
    expect(deleteSource.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId)).toEqual({ id: preparationId });

    const deleteClone = await ctx.app.inject({
      method: 'DELETE', url: `/api/v1/backtests/${cloneId}`, cookies: { session: cookie },
    });
    expect(deleteClone.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId)).toEqual({ id: preparationId });

    const deleteLast = await ctx.app.inject({
      method: 'DELETE', url: `/api/v1/backtests/${secondCloneId}`, cookies: { session: cookie },
    });
    expect(deleteLast.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId)).toBeUndefined();
  });

  async function expectPreviewWarningsRoundTrip(
    scenario: Scenario,
    warnings: readonly string[],
  ): Promise<void> {
    const { ctx, cookie, userId } = scenario;
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { session: cookie },
      payload: {
        universeRule: request.universeRule,
        period: request.period,
        strategyId: request.strategyId,
        parameters: request.parameters,
      },
    });
    expect(started.statusCode).toBe(202);
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);

    // 완료 작업의 검증 결과를 게시한 뒤 저장 본문만 바꿔 경고 복원을 확인한다.
    const ready = await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: { universeRule: request.universeRule, period: request.period, strategyId: request.strategyId, parameters: request.parameters } });
    expect(ready.statusCode).toBe(200);

    const preparation = ctx.container.database.sqlite.prepare(
      'SELECT preview_json FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId) as { preview_json: string };
    const preview = JSON.parse(preparation.preview_json) as Record<string, unknown>;
    const receipt = ctx.container.database.sqlite.prepare('SELECT * FROM preparation_preview_cache WHERE job_id = ?').get(preparationId) as { job_id: string; data_revision: number; validation_version: string; fundamental_symbols_json: string };
    ctx.container.database.sqlite.prepare(
      'UPDATE backtest_preparation_jobs SET preview_json = ? WHERE id = ?',
    ).run(JSON.stringify({ ...preview, warnings }), preparationId);
    ctx.container.database.sqlite.prepare('INSERT INTO preparation_preview_cache VALUES (?, ?, ?, ?)')
      .run(receipt.job_id, receipt.data_revision, receipt.validation_version, receipt.fundamental_symbols_json);

    // 요청에는 큰 경고 본문 대신 완료된 서버 준비 작업 ID만 보낸다.
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/universe',
      cookies: { session: cookie },
      payload: {
        universeRule: request.universeRule,
        lastPreview: { preparationJobId: preparationId },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().draft.payload.lastPreview.result.warnings).toEqual(warnings);

    const rawDraft = ctx.container.database.sqlite.prepare(
      'SELECT payload_json FROM backtest_wizard_drafts WHERE user_id = ? AND context = ?',
    ).get(userId, '') as { payload_json: string };
    expect(JSON.parse(rawDraft.payload_json)).toEqual({ universeRule: request.universeRule });

    const loaded = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft/universe',
      cookies: { session: cookie },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().draft.payload.lastPreview.result.warnings).toEqual(warnings);
  }

  it('경고가 1,000개를 넘어도 유니버스 초안을 저장하고 원문 순서와 중복을 복원한다', async ({ scenario }) => {
    const warnings = Array.from({ length: 1_100 }, (_, index) => `경고 ${index}`);
    warnings[317] = '중복 경고';
    warnings[318] = '중복 경고';

    await expectPreviewWarningsRoundTrip(scenario, warnings);
  });

  it('경고 원문이 2,000자를 넘어도 유니버스 초안을 저장하고 복원한다', async ({ scenario }) => {
    const warnings = [`원문 시작 ${'x'.repeat(4_200)} 원문 끝`];

    await expectPreviewWarningsRoundTrip(scenario, warnings);
  });

  it('같은 hash의 최신 준비가 있어도 원본 clone은 고정된 preparation을 재사용한다', async ({ scenario }) => {
    const { ctx, cookie } = scenario;
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: previewRequest,
    });
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: previewRequest,
    });
    const submitted = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { session: cookie }, payload: request,
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
    const cloned = await ctx.app.inject({
      method: 'POST', url: `/api/v1/backtests/${sourceId}/clone`, cookies: { session: cookie },
    });
    expect(cloned.statusCode).toBe(201);
    const cloneId = cloned.json<{ job: { id: string } }>().job.id;
    expect(ctx.container.jobQueue.getJob(cloneId)?.preparationJobId).toBe(preparationId);
    expect(ctx.container.jobQueue.getJob(cloneId)?.universeScheduleJson)
      .toBe(ctx.container.jobQueue.getJob(sourceId)?.universeScheduleJson);
    expect(resolver).not.toHaveBeenCalled();

    expect(ctx.container.jobQueue.setStatus(sourceId, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    const deleted = await ctx.app.inject({
      method: 'DELETE', url: `/api/v1/backtests/${sourceId}`, cookies: { session: cookie },
    });
    expect(deleted.statusCode).toBe(204);
    const cloneAgain = await ctx.app.inject({
      method: 'POST', url: `/api/v1/backtests/${cloneId}/clone`, cookies: { session: cookie },
    });
    expect(cloneAgain.statusCode).toBe(201);
  });

  it('미리보기 소유권이 없는 사용자의 제출을 자동 준비 fixture 없이 거부한다', async ({ scenario }) => {
    const { ctx, cookie, otherCookie } = scenario;
    const preview = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
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
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: {
        universeRule: request.universeRule,
        period: request.period,
        strategyId: request.strategyId,
        parameters: request.parameters,
      },
    });

    const rejected = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { session: otherCookie }, payload: request,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<{ error: string }>().error).toBe('PREPARATION_REQUIRED');
  });

  it('enqueue 직전 원본 데이터가 바뀌면 준비 필요 응답과 소유권을 보존한다', async ({ scenario }) => {
    const { ctx, cookie, userId } = scenario;
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: previewRequest,
    });
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
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
    const rejected = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { session: cookie }, payload: request,
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

  it('초안 교체와 삭제는 이전 terminal 준비를 수집하고 다른 사용자 참조는 보존한다', async ({ scenario }) => {
    const { ctx, cookie, otherCookie, userId } = scenario;
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: previewRequest,
    });
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: previewRequest,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: otherCookie },
      payload: previewRequest,
    });

    const fake = await ctx.app.inject({
      method: 'PUT', url: '/api/v1/backtests/wizard-draft/universe', cookies: { session: cookie },
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
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: replacementRequest,
    });
    expect(replacementStarted.statusCode).toBe(202);
    const replacementId = replacementStarted.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, replacementId);
    const replacementReady = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
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
      method: 'DELETE', url: '/api/v1/backtests/wizard-draft?all=true', cookies: { session: otherCookie },
    });
    expect(otherCleared.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(preparationId)).toBeUndefined();
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(replacementId)).toEqual({ id: replacementId });

    const finalCleared = await ctx.app.inject({
      method: 'DELETE', url: '/api/v1/backtests/wizard-draft', cookies: { session: cookie },
    });
    expect(finalCleared.statusCode).toBe(204);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get(replacementId)).toBeUndefined();
    expect(ctx.container.database.sqlite.prepare(
      'SELECT job_id FROM preparation_preview_cache WHERE job_id IN (?, ?)',
    ).all(preparationId, replacementId)).toEqual([]);
  });

  it('enqueue 실패는 wizard 참조와 초안을 같은 트랜잭션으로 보존한다', async ({ scenario }) => {
    const { ctx, cookie, userId } = scenario;
    const previewRequest = {
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    };
    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: previewRequest,
    });
    const preparationId = started.json<{ job: { id: string } }>().job.id;
    await waitForPreparation(ctx, preparationId);
    await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie },
      payload: previewRequest,
    });
    await ctx.app.inject({
      method: 'PUT', url: '/api/v1/backtests/wizard-draft/universe', cookies: { session: cookie },
      payload: { universeRule: request.universeRule, lastPreview: { preparationJobId: preparationId } },
    });
    ctx.container.database.sqlite.exec(`
      CREATE TRIGGER fail_reference_test_enqueue
      BEFORE INSERT ON backtest_jobs
      BEGIN SELECT RAISE(ABORT, 'forced enqueue failure'); END;
    `);

    const failed = await ctx.app.inject({
      method: 'POST', url: '/api/v1/backtests', cookies: { session: cookie }, payload: request,
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
