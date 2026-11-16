import { describe, expect, vi } from 'vitest';
import { PreparationReferenceService } from '../../src/server/modules/backtest/application/preparation-reference-service.js';
import type { BacktestWizardJob } from '../../src/shared/schemas/backtest-wizard-draft.js';
import { createTestAdmin, type TestApp } from '../helpers/test-app.js';
import { authenticatedTest as it } from '../helpers/test-fixtures.js';

async function login(ctx: TestApp, username: string, password: string): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.find((cookie) => cookie.name === 'session')!.value;
}

describe('backtest wizard draft routes', () => {
  it('requires authentication for reading, saving, and clearing drafts', async ({ ctx }) => {
    for (const [method, url, payload] of [
      ['GET', '/api/v1/backtests/wizards/missing', undefined],
      ['POST', '/api/v1/backtests/wizards', {}],
      ['POST', '/api/v1/backtests/wizards/missing/cancel', {}],
      ['GET', '/api/v1/backtests/wizard-draft/strategy', undefined],
      ['PUT', '/api/v1/backtests/wizard-draft/strategy', { strategyId: null, parameters: {} }],
      ['DELETE', '/api/v1/backtests/wizard-draft', undefined],
      ['DELETE', '/api/v1/backtests/wizard-draft?all=true', undefined],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('persists each validated step independently', async ({ ctx, cookie }) => {
    const payloads = {
      strategy: { strategyId: 'range-breakout', parameters: { lookbackBars: '17' } },
      period: {
        from: '2026-01-05',
        to: '2026-03-31',
      },
      universe: {
        universeRule: {
          markets: ['KOSPI'],
          stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 20 }],
          rebalanceInterval: { value: 1, unit: 'MONTH' },
        },
        lastPreview: null,
      },
      capital: {
        initialCash: '12345678',
        maxPositions: '7',
        maxPositionWeightPercent: '12.5',
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
        randomSeed: '99',
      },
    } as const;

    for (const [step, payload] of Object.entries(payloads)) {
      const saved = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/backtests/wizard-draft/${step}`,
        cookies: { session: cookie },
        payload,
      });
      expect(saved.statusCode, step).toBe(200);
      expect(saved.json().draft).toMatchObject({ step, payload });

      const loaded = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/backtests/wizard-draft/${step}`,
        cookies: { session: cookie },
      });
      expect(loaded.statusCode, step).toBe(200);
      expect(loaded.json().draft).toMatchObject({ step, payload });
      expect(loaded.json().draft.updatedAtMs).toEqual(expect.any(Number));
    }
    const { maxPositionWeightPercent: _cap, ...legacyCapital } = payloads.capital;
    const legacy = await ctx.app.inject({
      method: 'PUT', url: '/api/v1/backtests/wizard-draft/capital',
      cookies: { session: cookie }, payload: legacyCapital,
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().draft.payload.maxPositionWeightPercent).toBe('');
  });

  it('separates new and clone contexts and clears only the requested context', async ({ ctx, cookie }) => {
    const newPayload = { strategyId: 'range-breakout', parameters: { lookbackBars: '17' } };
    const clonePayload = { strategyId: 'range-breakout', parameters: { lookbackBars: '33' } };
    for (const [query, payload] of [
      ['', newPayload],
      ['?sourceJobId=bt_source', clonePayload],
    ] as const) {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/backtests/wizard-draft/strategy${query}`,
        cookies: { session: cookie },
        payload,
      });
      expect(response.statusCode).toBe(200);
    }

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/backtests/wizard-draft',
      cookies: { session: cookie },
    });
    expect(removed.statusCode).toBe(204);

    const fresh = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft/strategy',
      cookies: { session: cookie },
    });
    expect(fresh.json()).toEqual({ draft: null });
    const clone = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft/strategy?sourceJobId=bt_source',
      cookies: { session: cookie },
    });
    expect(clone.json().draft.payload).toEqual(clonePayload);
  });

  // 기존 사용자별 초안 테스트는 같은 사용자의 병렬 위저드와 취소 후 늦은 저장을 구분하지 못했다.
  it('독립된 위저드를 조회·재개하고 다른 위저드와 늦은 저장에서 보호한다', async ({ ctx, cookie }) => {
    const create = async () => {
      const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/wizards', cookies: { session: cookie }, payload: {} });
      expect(response.statusCode).toBe(201);
      return response.json<{ wizard: BacktestWizardJob }>().wizard;
    };
    const a = await create(), b = await create();
    expect(a.id).not.toBe(b.id);
    const save = (id: string, value: string) => ctx.app.inject({ method: 'PUT',
      url: `/api/v1/backtests/wizard-draft/strategy?wizardId=${id}`, cookies: { session: cookie },
      payload: { strategyId: 'range-breakout', parameters: { lookbackBars: value }, currentStep: 'period' } });
    expect((await save(a.id, '17')).statusCode).toBe(200);
    expect((await save(b.id, '33')).statusCode).toBe(200);
    const jobs = (await ctx.app.inject({ method: 'GET', url: '/api/v1/jobs?status=active', cookies: { session: cookie } })).json().jobs;
    expect(jobs.filter((job: { kind: string }) => job.kind === 'backtest-wizard')).toHaveLength(2);
    expect(jobs.find((job: { id: string }) => job.id === `backtest-wizard:${a.id}`)).toMatchObject({ status: 'WAITING', link: `/backtests/new/period?wizard=${a.id}` });
    for (const query of [`wizardId=${a.id}`, `sourceJobId=${a.id}`]) {
      expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/backtests/wizard-draft?${query}`, cookies: { session: cookie } })).statusCode).toBe(409);
    }
    await ctx.app.inject({ method: 'DELETE', url: '/api/v1/backtests/wizard-draft?all=true', cookies: { session: cookie } });
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/jobs/backtest-wizard:${a.id}/cancel`, cookies: { session: cookie } })).json().job.status).toBe('CANCELLED');
    expect((await save(a.id, '99')).statusCode).toBe(409);
    const remaining = await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/wizard-draft/strategy?wizardId=${b.id}`, cookies: { session: cookie } });
    expect(remaining.json().draft.payload.parameters.lookbackBars).toBe('33');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/wizards/${b.id}`, cookies: { session: cookie } })).json().wizard.status).toBe('WAITING');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/backtests/wizard-draft', cookies: { session: cookie } })).statusCode).toBe(404);
  });

  it('공유 수집은 한 위저드 취소로 중단하지 않고 준비 완료·실패 후에도 명시적 실행을 기다린다', async ({ ctx, cookie, admin }) => {
    const owner = ctx.container.userRepository.findByUsername(admin.username)!.id;
    const service = ctx.container.backtestWizardService;
    const references = new PreparationReferenceService(ctx.container.database);
    const a = service.create(owner), b = service.create(owner);
    const db = ctx.container.database.sqlite;
    const now = ctx.container.clock.now();
    db.prepare(`INSERT INTO backtest_preparation_jobs
      (id,status,phase,request_hash,request_json,created_at_ms,updated_at_ms) VALUES ('shared-wizard','RUNNING','RESOLVING_STAGES','hash','{}',?,?)`).run(now,now);
    references.bindWizard(owner, a.id, 'shared-wizard');
    references.bindWizard(owner, b.id, 'shared-wizard');
    expect(service.get(owner, a.id).status).toBe('RUNNING');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/preparation-jobs/shared-wizard/cancel', cookies: { session: cookie } })).statusCode).toBe(409);
    const list = () => ctx.app.inject({ method: 'GET', url: '/api/v1/jobs', cookies: { session: cookie } });
    expect((await list()).json().jobs.map((job: { kind: string }) => job.kind)).toEqual(['backtest-wizard','backtest-wizard']);
    // 위저드와 공유해도 별도 API 소비자의 준비 작업까지 목록에서 숨기지 않는다.
    references.bindWizard(owner, '', 'shared-wizard');
    expect((await list()).json().jobs.some((job: { id: string }) => job.id === 'preparation:shared-wizard')).toBe(true);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/jobs/preparation:shared-wizard/cancel', cookies: { session: cookie } })).statusCode).toBe(409);
    references.releaseWizard(owner, '');
    const other = await createTestAdmin(ctx.container, { username: 'standalone-wizard-consumer' });
    const otherOwner = ctx.container.userRepository.findByUsername(other.username)!.id;
    const otherCookie = await login(ctx,other.username,other.password);
    references.bindWizard(otherOwner,'','shared-wizard');
    references.releaseWizard(otherOwner,'');
    const otherJobs = (await ctx.app.inject({ method: 'GET', url: '/api/v1/jobs', cookies: { session: otherCookie } })).json().jobs;
    expect(otherJobs.some((job: { id: string }) => job.id === 'preparation:shared-wizard')).toBe(true);
    expect(otherJobs.some((job: { kind: string }) => job.kind === 'backtest-wizard')).toBe(false);
    service.cancel(owner, a.id);
    expect(db.prepare("SELECT cancel_requested FROM backtest_preparation_jobs WHERE id='shared-wizard'").get()).toEqual({ cancel_requested: 0 });
    db.prepare("UPDATE backtest_preparation_jobs SET status='COMPLETED', completed_at_ms=? WHERE id='shared-wizard'").run(now);
    expect(service.get(owner, b.id)).toMatchObject({ status: 'WAITING', phase: '유니버스 준비 완료 · 사용자 입력 대기', backtestJobId: null, finishedAtMs: null });
    db.prepare(`INSERT INTO backtest_jobs (id,status,strategy_id,request_json,universe_rule_json,universe_schedule_json,created_at_ms)
      VALUES ('wizard-run','RUNNING','range-breakout','{}','{}','[]',?)`).run(now);
    references.finishWizard(owner, b.id, 'shared-wizard', 'wizard-run');
    expect(service.get(owner, b.id)).toMatchObject({ status: 'RUNNING', currentStep: 'run', finishedAtMs: null });
    expect((await list()).json().jobs.some((job: { kind: string }) => job.kind === 'backtest')).toBe(false);
    const late = await ctx.app.inject({ method: 'PUT', url: `/api/v1/backtests/wizard-draft/strategy?wizardId=${b.id}`, cookies: { session: cookie }, payload: { strategyId: null, parameters: {} } });
    expect(late.statusCode).toBe(409);
    const cancel = vi.spyOn(ctx.container.jobOrchestrator, 'cancel').mockImplementationOnce(() => { throw new Error('취소 저장 실패'); });
    expect(() => service.cancel(owner,b.id)).toThrow('취소 저장 실패');
    expect(service.get(owner,b.id).status).toBe('RUNNING');
    expect(references.getWizard(owner,b.id)?.preparationJobId).toBe('shared-wizard');
    cancel.mockRestore();
    db.prepare("UPDATE backtest_jobs SET status='FAILED', error='계산 실패', completed_at_ms=? WHERE id='wizard-run'").run(now+1);
    expect(service.get(owner, b.id)).toMatchObject({ status: 'WAITING', error: '계산 실패', finishedAtMs: null });
    db.prepare("UPDATE backtest_jobs SET status='COMPLETED', error=NULL, completed_at_ms=? WHERE id='wizard-run'").run(now+2);
    expect(service.get(owner, b.id)).toMatchObject({ status: 'COMPLETED', link: '/backtests/wizard-run', finishedAtMs: now+2 });
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/v1/jobs', cookies: { session: cookie }, payload: { ids: [`backtest-wizard:${b.id}`] } })).statusCode).toBe(204);
    expect((await list()).json().jobs.map((job: { id: string }) => job.id)).not.toContain(`backtest-wizard:${b.id}`);
  });

  // 상태 이벤트 전 서버가 중단된 뒤 결과를 삭제하면 부모의 완료 증거가 사라지는 경로를 보호한다.
  it('완료 이벤트를 놓친 결과도 삭제 전에 부모 위저드 완료를 보존한다', async ({ ctx, cookie, admin }) => {
    const owner = ctx.container.userRepository.findByUsername(admin.username)!.id;
    const db = ctx.container.database.sqlite;
    const now = ctx.container.clock.now();
    for (const mode of ['route', 'queue']) {
      const wizard = ctx.container.backtestWizardService.create(owner);
      const id = `wizard-delete-${mode}`;
      db.prepare(`INSERT INTO backtest_jobs (id,status,strategy_id,request_json,universe_rule_json,universe_schedule_json,created_at_ms,completed_at_ms)
        VALUES (?,'COMPLETED','range-breakout','{}','{}','[]',?,?)`).run(id,now,now+1);
      db.prepare("UPDATE backtest_wizard_jobs SET backtest_job_id=?,status='RUNNING' WHERE id=?").run(id,wizard.id);
      if (mode === 'route') {
        const response = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/backtests/${id}`, cookies: { session: cookie } });
        expect(response.statusCode).toBe(204);
      } else expect(ctx.container.jobQueue.deleteJob(id)).toBe(true);
      expect(ctx.container.jobQueue.getJob(id)).toBeNull();
      expect(ctx.container.backtestWizardService.get(owner,wizard.id)).toMatchObject({ status: 'COMPLETED', finishedAtMs: now+1 });
    }
  });

  it('does not expose another user draft', async ({ ctx, cookie }) => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/strategy',
      cookies: { session: cookie },
      payload: { strategyId: 'range-breakout', parameters: {} },
    });
    const other = await createTestAdmin(ctx.container, {
      username: 'other-operator',
      password: 'different-correct-password',
    });
    const otherCookie = await login(ctx, other.username, other.password);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft/strategy',
      cookies: { session: otherCookie },
    });
    expect(response.json()).toEqual({ draft: null });
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/wizards', cookies: { session: cookie }, payload: {} });
    const id = created.json().wizard.id;
    for (const [method, url, payload] of [
      ['GET', `/api/v1/backtests/wizards/${id}`, undefined],
      ['POST', `/api/v1/backtests/wizards/${id}/cancel`, undefined],
      ['GET', `/api/v1/backtests/wizard-draft/strategy?wizardId=${id}`, undefined],
      ['PUT', `/api/v1/backtests/wizard-draft/strategy?wizardId=${id}`, { strategyId: null, parameters: {} }],
    ] as const) {
      expect((await ctx.app.inject({ method, url, cookies: { session: otherCookie }, ...(payload ? { payload } : {}) })).statusCode).toBe(404);
    }
  });
  it('rejects unknown steps and malformed payloads', async ({ ctx, cookie }) => {
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft/review',
      cookies: { session: cookie },
    });
    expect(unknown.statusCode).toBe(400);

    const malformed = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/capital',
      cookies: { session: cookie },
      payload: { initialCash: 1000 },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
