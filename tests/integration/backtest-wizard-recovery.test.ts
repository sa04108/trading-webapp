import { describe, expect, vi } from 'vitest';
import { authenticatedTest } from '../helpers/test-fixtures.js';
import { UNFILTERED_BREAKOUT_CONTROLS } from '../helpers/swing-controls.js';
import { BacktestWizardRecoveryService } from '../../src/server/modules/backtest/application/backtest-wizard-recovery-service.js';
import type { TestApp } from '../helpers/test-app.js';
import type { PreparationInput } from '../../src/shared/schemas/backtest-preparation.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { PreparationPreviewCache } from '../../src/runtime/modules/backtest/application/preparation-preview-cache.js';
import { preparationRuntimeVersions, preparationRuntimeVersionsJson } from '../../src/runtime/modules/backtest/application/preparation-runtime-versions.js';

const it = authenticatedTest.extend({ appOptions: { agentPreparation: true } });
const input: PreparationInput = {
  strategyId: 'range-breakout', parameters: UNFILTERED_BREAKOUT_CONTROLS,
  period: { from: '2024-01-01', to: '2025-01-01' },
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'MONTH', value: 1 } },
};
const request: BacktestRequest = {
  ...input, capital: { initialCash: 10_000_000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'kr-equity-default', slippageProfileId: 'fixed-5bps' },
  risk: { maxPositions: 5 }, randomSeed: 42,
};
function owner(ctx: TestApp, username: string): string {
  return (ctx.container.database.sqlite.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: string }).id;
}
function recovery(ctx: TestApp) {
  const c = ctx.container;
  return new BacktestWizardRecoveryService(c.database, c.clock, c.backtestWizardService, c.backtestPreparationOrchestrator,
    notification => { c.notificationService.events.emit('notification', notification); }, async () => {});
}
function old(ctx: TestApp, wizardId: string): void {
  ctx.container.database.sqlite.prepare("UPDATE backtest_wizard_jobs SET runtime_versions_json='{}' WHERE id=?").run(wizardId);
}
function start(ctx: TestApp, userId: string) {
  const c = ctx.container;
  const wizard = c.backtestWizardService.create(userId);
  const prep = c.backtestPreparationOrchestrator.start(input, { userId, context: wizard.id });
  return { wizard, prep };
}

describe('백테스트 위저드 버전 복구', () => {
  // 기존 위저드 수명 테스트는 부팅의 버전 비교·리스 폐기·알림 트랜잭션을 실행하지 않는다.
  it('변경된 준비의 이전 임대를 차단하고 재준비와 알림을 한 번만 만든다', async ({ ctx, admin, cookie }) => {
    const c = ctx.container, userId = owner(ctx, admin.username), db = c.database.sqlite;
    const { wizard, prep } = start(ctx, userId);
    const queue = c.agentCoordinator.preparations;
    const lease = queue.claim('agent', { version: 1 } as never)!;
    expect(lease.jobId).toBe(prep.id);
    old(ctx, wizard.id);
    const emit = vi.spyOn(c.notificationService.events, 'emit');
    const service = recovery(ctx);
    service.recover();
    const current = c.backtestWizardService.get(userId, wizard.id);
    expect(current).toMatchObject({ currentStep: 'universe', backtestJobId: null, recovery: { status: 'PREPARING', error: null } });
    expect(current.recovery?.message).toContain('직접 실행');
    expect(current.preparationJobId).not.toBe(prep.id);
    expect(db.prepare('SELECT status FROM backtest_preparation_jobs WHERE id=?').get(prep.id)).toEqual({ status: 'CANCELLED' });
    expect(queue.heartbeat('agent', lease).accepted).toBe(false);
    const late = vi.fn();
    expect(queue.waitForData('agent', lease, late)).toBe(false);
    expect(late).not.toHaveBeenCalled();
    const notifications = db.prepare('SELECT title,link FROM notifications').all();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ link: `/backtests/new/universe?wizard=${wizard.id}` });
    expect(emit).toHaveBeenCalledTimes(1);
    service.recover();
    expect(db.prepare('SELECT count(*) AS n FROM notifications').get()).toEqual({ n: 1 });
    expect(emit).toHaveBeenCalledTimes(1);
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/wizards/${wizard.id}`, cookies: { session: cookie } });
    expect(response.json().wizard.recovery.status).toBe('PREPARING');
    const jobs = await ctx.app.inject({ method: 'GET', url: '/api/v1/jobs?status=active', cookies: { session: cookie } });
    expect(jobs.json().jobs.find((job: { id: string }) => job.id === `backtest-wizard:${wizard.id}`)).toMatchObject({
      phase: '버전 변경 감지 · 유니버스 자동 재준비 중', link: `/backtests/new/universe?wizard=${wizard.id}`,
    });
    db.prepare("UPDATE backtest_preparation_jobs SET status='COMPLETED' WHERE id=?").run(current.preparationJobId);
    expect(c.backtestWizardService.get(userId, wizard.id)).toMatchObject({ status: 'WAITING', backtestJobId: null, recovery: { status: 'WAITING_INPUT' } });
    expect(db.prepare('SELECT count(*) AS n FROM backtest_jobs').get()).toEqual({ n: 0 });
  });

  it('동일 버전과 종료된 위저드는 건드리지 않고 공유된 이전 준비를 새 요청에 재사용하지 않는다', ({ ctx, admin }) => {
    const c = ctx.container, userId = owner(ctx, admin.username), db = c.database.sqlite;
    const { wizard, prep } = start(ctx, userId);
    const shared = c.backtestWizardService.create(userId);
    c.backtestPreparationOrchestrator.bindWizard(userId, shared.id, prep.id);
    const untouched = c.backtestWizardService.create(userId);
    const sameVersion = c.backtestWizardService.create(userId);
    const samePreparation = c.backtestPreparationOrchestrator.start({ ...input, parameters: { ...input.parameters, lookbackBars: 11 } }, { userId, context: sameVersion.id });
    const legacy = c.backtestWizardService.create(userId);
    c.backtestPreparationOrchestrator.bindWizard(userId, legacy.id, prep.id);
    db.prepare('UPDATE backtest_wizard_jobs SET runtime_versions_json=NULL WHERE id=?').run(legacy.id);
    const terminal = c.backtestWizardService.create(userId);
    db.prepare("UPDATE backtest_wizard_jobs SET status='CANCELLED', runtime_versions_json='{}' WHERE id=?").run(terminal.id);
    db.prepare("UPDATE backtest_preparation_jobs SET runtime_versions_json='{}' WHERE id=?").run(prep.id);
    old(ctx, wizard.id);
    expect(c.backtestPreparationOrchestrator.getActive(input)).toBeNull();
    recovery(ctx).recover();
    expect(c.backtestWizardService.get(userId, wizard.id).preparationJobId).not.toBe(prep.id);
    expect(c.backtestWizardService.get(userId, shared.id).preparationJobId).toBe(prep.id);
    expect(c.backtestPreparationOrchestrator.get(prep.id)?.status).toBe('QUEUED');
    expect(c.backtestWizardService.get(userId, untouched.id).recovery).toBeNull();
    expect(c.backtestWizardService.get(userId, sameVersion.id)).toMatchObject({ preparationJobId: samePreparation.id, recovery: null });
    expect(c.backtestWizardService.get(userId, legacy.id).preparationJobId).toBe(c.backtestWizardService.get(userId, wizard.id).preparationJobId);
    expect(c.backtestWizardService.get(userId, terminal.id).status).toBe('CANCELLED');
    expect(c.backtestPreparationOrchestrator.start(input).id).not.toBe(prep.id);
  });

  it('실행 중 백테스트를 중지하고 새 준비가 완료돼도 자동 실행하지 않는다', ({ ctx, admin }) => {
    const c = ctx.container, userId = owner(ctx, admin.username), db = c.database.sqlite;
    const { wizard } = start(ctx, userId);
    const job = c.jobQueue.enqueue(request);
    db.prepare("UPDATE backtest_jobs SET status='RUNNING', lease_token_hash='old-token', lease_expires_at_ms=? WHERE id=?").run(Date.now() + 60000, job.id);
    db.prepare("UPDATE backtest_wizard_jobs SET backtest_job_id=?, current_step='run', status='RUNNING', runtime_versions_json='{}' WHERE id=?").run(job.id, wizard.id);
    recovery(ctx).recover();
    const row = db.prepare('SELECT status,lease_token_hash FROM backtest_jobs WHERE id=?').get(job.id);
    expect(row).toEqual({ status: 'CANCELLED', lease_token_hash: null });
    const current = c.backtestWizardService.get(userId, wizard.id);
    expect(current).toMatchObject({ currentStep: 'universe', backtestJobId: null, recovery: { status: 'PREPARING' } });
    db.prepare("UPDATE backtest_preparation_jobs SET status='COMPLETED' WHERE id=?").run(current.preparationJobId);
    expect(c.backtestWizardService.get(userId, wizard.id).recovery?.status).toBe('WAITING_INPUT');
    expect(db.prepare('SELECT count(*) AS n FROM backtest_jobs').get()).toEqual({ n: 1 });
  });

  it('손상된 요청이나 제거된 전략은 사용자에게 복구 실패를 알린다', async ({ ctx, admin, cookie }) => {
    const c = ctx.container, userId = owner(ctx, admin.username), db = c.database.sqlite;
    const { wizard, prep } = start(ctx, userId);
    db.prepare("UPDATE backtest_preparation_jobs SET request_json='invalid' WHERE id=?").run(prep.id);
    old(ctx, wizard.id);
    recovery(ctx).recover();
    const row = db.prepare('SELECT recovery_error FROM backtest_wizard_jobs WHERE id=?').get(wizard.id) as { recovery_error: string };
    expect(row.recovery_error).toContain('복원하지 못했습니다');
    expect(db.prepare('SELECT severity FROM notifications').get()).toEqual({ severity: 'error' });
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/wizards/${wizard.id}`, cookies: { session: cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().wizard).toMatchObject({ currentStep: 'universe', recovery: { status: 'FAILED', error: row.recovery_error } });

    const removed = start(ctx, userId);
    db.prepare('UPDATE backtest_preparation_jobs SET request_json=? WHERE id=?')
      .run(JSON.stringify({ ...input, strategyId: 'removed-strategy' }), removed.prep.id);
    old(ctx, removed.wizard.id);
    recovery(ctx).recover();
    expect(c.backtestWizardService.get(userId, removed.wizard.id).recovery).toMatchObject({
      status: 'FAILED', error: expect.stringContaining('알 수 없는 전략'),
    });
  });

  it('알림 저장이 실패하면 작업 교체와 펜싱 및 이벤트를 모두 롤백한다', ({ ctx, admin }) => {
    const c = ctx.container, userId = owner(ctx, admin.username), db = c.database.sqlite;
    const { wizard, prep } = start(ctx, userId);
    old(ctx, wizard.id);
    const emit = vi.spyOn(c.notificationService.events, 'emit');
    db.exec("CREATE TRIGGER fail_recovery_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'forced notification failure'); END");
    expect(() => recovery(ctx).recover()).toThrow('forced notification failure');
    expect(c.backtestWizardService.get(userId, wizard.id).preparationJobId).toBe(prep.id);
    expect(c.backtestPreparationOrchestrator.get(prep.id)?.status).toBe('QUEUED');
    expect(db.prepare('SELECT count(*) AS n FROM backtest_preparation_jobs').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM notifications').get()).toEqual({ n: 0 });
    expect(emit).not.toHaveBeenCalled();
  });

  it('복구 실패 후 이전 프로토콜의 완료 미리보기로 제출할 수 없다', async ({ ctx, admin, cookie }) => {
    const c = ctx.container, userId = owner(ctx, admin.username), db = c.database.sqlite;
    const { wizard, prep } = start(ctx, userId);
    const preview = { schedule: [], diagnostics: [], stages: [], unionSymbols: [], scheduleHash: 'test',
      uncoveredDates: [], periodCovered: true, missingCandleSymbols: [], warnings: [] };
    db.prepare("UPDATE backtest_preparation_jobs SET status='COMPLETED', preview_json=?, runtime_versions_json=? WHERE id=?")
      .run(JSON.stringify(preview), preparationRuntimeVersionsJson(), prep.id);
    const cache = new PreparationPreviewCache(c.database);
    cache.store(prep.id, cache.revision(), []);
    expect(cache.isFresh(prep.id)).toBe(true);
    expect(c.backtestPreparationOrchestrator.getFreshPreviewDetails(input, prep.id)).not.toBeNull();
    const save = await ctx.app.inject({ method: 'PUT', url: `/api/v1/backtests/wizard-draft/universe?wizardId=${wizard.id}`,
      cookies: { session: cookie }, payload: { universeRule: input.universeRule, lastPreview: { preparationJobId: prep.id } } });
    expect(save.json().draft.payload.lastPreview.result.preparationJobId).toBe(prep.id);

    const job = c.jobQueue.enqueue(request);
    db.prepare("UPDATE backtest_jobs SET status='RUNNING', request_json=? WHERE id=?")
      .run(JSON.stringify({ ...request, capital: null }), job.id);
    db.prepare("UPDATE backtest_wizard_jobs SET backtest_job_id=?, current_step='run', status='RUNNING', runtime_versions_json='{}' WHERE id=?").run(job.id, wizard.id);
    db.prepare('UPDATE backtest_preparation_jobs SET runtime_versions_json=? WHERE id=?')
      .run(JSON.stringify({ ...preparationRuntimeVersions(), protocolVersion: 'old-protocol' }), prep.id);
    recovery(ctx).recover();

    expect(c.backtestWizardService.get(userId, wizard.id).recovery?.status).toBe('FAILED');
    expect(cache.isFresh(prep.id)).toBe(false);
    expect(c.backtestPreparationOrchestrator.getFreshPreviewDetails(input, prep.id)).toBeNull();
    const loaded = await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/wizard-draft/universe?wizardId=${wizard.id}`, cookies: { session: cookie } });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().draft.payload.lastPreview).toBeNull();
    const submit = await ctx.app.inject({ method: 'POST', url: `/api/v1/backtests?wizardId=${wizard.id}`, cookies: { session: cookie }, payload: request });
    expect(submit.statusCode).toBe(409);
    expect(submit.json().error).toBe('PREPARATION_REQUIRED');
    expect(db.prepare('SELECT count(*) AS n FROM backtest_jobs').get()).toEqual({ n: 1 });
  });
});
