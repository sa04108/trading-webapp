import { describe, expect, vi } from 'vitest';
import { test as it } from '../helpers/test-fixtures.js';
import { ConfigurationSearchService, ConfigurationSearchError, type ConfigurationSearchAdapter } from '../../src/server/modules/backtest/application/configuration-search-service.js';
import { PreparationReferenceError } from '../../src/server/modules/backtest/application/preparation-reference-service.js';
import { createIntradaySearchAdapter } from '../../src/server/modules/backtest/application/intraday-search-adapter.js';
import { intradayRuns } from '../../src/server/shared/db/intraday-schema.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { ConfigurationSearchCatalog } from '../../src/shared/schemas/configuration-search.js';

const request: BacktestRequest = { strategyId: 'range-breakout', parameters: {}, universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'NONE', value: 1 } }, period: { from: '2026-01-01', to: '2026-01-02' }, capital: { initialCash: 10000, currency: 'KRW' }, execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'zero-cost', slippageProfileId: 'zero-slippage' }, risk: { maxPositions: 1 }, randomSeed: 42 };
const catalog: ConfigurationSearchCatalog = { mode: 'daily', sourceJobId: 'source', strategyId: request.strategyId, strategyName: 'test', period: request.period, fields: [], maxCount: 100 };
const input = { requestId: '123e4567-e89b-42d3-a456-426614174000', config: { count: 2, settings: { x: { kind: 'RANGE' as const, min: 1, max: 2 } } } };

describe('configuration search persistence', () => {
  it('취소 의도만 저장된 상태로 재시작하면 남은 자식에 취소를 전달한다', async ({ ctx }) => {
    let jobStatus = 'QUEUED'; let cancelDelivered = false;
    const adapter: ConfigurationSearchAdapter = { source: () => ({ catalog, request, runtimeIdentity: 'v1' }), sample: () => [{ request, values: { x: 1 } }], runtimeIdentity: () => 'v1', buildSubmission: async () => () => 'job', job: () => ({ status: jobStatus, error: null, metrics: null }), cancelJob: () => { cancelDelivered = true; jobStatus = 'CANCELLED'; }, deleteJob: () => {} };
    const deps = { database: ctx.container.database, clock: ctx.container.clock, adapters: { daily: adapter, intraday: adapter }, onFinished: () => {}, collectPreparations: () => {} };
    const service = new ConfigurationSearchService(deps);
    const preview = service.preview('owner', 'daily', 'source', { ...input, config: { ...input.config, count: 1 } });
    service.start('owner', preview.id); await service.pump(); await service.stop();
    ctx.container.database.sqlite.prepare("UPDATE configuration_searches SET status='CANCELLING' WHERE id=?").run(preview.id);
    const restarted = new ConfigurationSearchService(deps);
    await restarted.pump();
    expect(cancelDelivered).toBe(true);
    expect(restarted.get('owner', preview.id).status).toBe('CANCELLED');
  });
  // 취소 상태가 먼저 저장되어도 실제 분봉 처리기가 종료되기 전에는 부모를 완료하지 않는다.
  it('분봉 취소는 자식 처리기가 종료된 뒤에만 종료 상태를 반환한다', ({ ctx }) => {
    ctx.container.database.db.insert(intradayRuns).values({ id: 'draining-search-child', ownerId: 'owner', requestJson: '{}', status: 'CANCELLED', createdAtMs: 1, updatedAtMs: 1 }).run();
    const draining = vi.spyOn(ctx.container.intradayService, 'isDraining').mockReturnValue(true);
    const adapter = createIntradaySearchAdapter(ctx.container.database, ctx.container.intradayService, ctx.container.strategyRegistry);
    expect(adapter.job('owner', 'draining-search-child')?.status).toBe('CANCELLING');
    draining.mockReturnValue(false);
    expect(adapter.job('owner', 'draining-search-child')?.status).toBe('CANCELLED');
    draining.mockRestore();
  });
  it('제출 후 시작 실패는 같은 자식을 다시 시작하며 중복 생성하지 않는다', async ({ ctx }) => {
    let creates = 0; let starts = 0;
    const adapter: ConfigurationSearchAdapter = { source: () => ({ catalog, request, runtimeIdentity: 'v1' }), sample: () => [{ request, values: { x: 1 } }], runtimeIdentity: () => 'v1', buildSubmission: async () => () => { creates++; return 'job'; }, afterSubmit: () => { if (++starts === 1) throw new Error('start failed'); }, job: () => ({ status: 'QUEUED', error: null, metrics: null }), cancelJob: () => {}, deleteJob: () => {} };
    const service = new ConfigurationSearchService({ database: ctx.container.database, clock: ctx.container.clock, adapters: { daily: adapter, intraday: adapter }, onFinished: () => {}, collectPreparations: () => {} });
    const preview = service.preview('owner', 'daily', 'source', { ...input, config: { ...input.config, count: 1 } });
    service.start('owner', preview.id);
    await expect(service.pump()).rejects.toThrow('start failed');
    expect(service.get('owner', preview.id).items[0]?.jobId).toBe('job');
    await service.pump(); expect(creates).toBe(1); expect(starts).toBe(2);
  });
  it('취소 시 준비 참조를 먼저 해제한 후 소유권 정리를 요청한다', async ({ ctx }) => {
    ctx.container.database.sqlite.prepare("INSERT INTO backtest_preparation_jobs (id, request_hash, request_json, status, phase, lifecycle_managed, created_at_ms, updated_at_ms) VALUES ('prep', 'hash', '{}', 'QUEUED', 'QUEUED', 1, 1, 1)").run();
    let released = 0;
    const adapter: ConfigurationSearchAdapter = { source: () => ({ catalog, request, runtimeIdentity: 'v1' }), sample: () => [{ request, values: { x: 1 } }], runtimeIdentity: () => 'v1', prepare: () => ({ preparationJobId: 'prep', ready: false }), releasePreparation: id => { expect(id).toBe('prep'); expect(ctx.container.database.sqlite.prepare('SELECT COUNT(*) AS n FROM configuration_search_items WHERE preparation_job_id = ?').get(id)).toEqual({ n: 0 }); released++; }, buildSubmission: async () => null, job: () => null, cancelJob: () => {}, deleteJob: () => {} };
    const service = new ConfigurationSearchService({ database: ctx.container.database, clock: ctx.container.clock, adapters: { daily: adapter, intraday: adapter }, onFinished: () => {}, collectPreparations: () => {} });
    const preview = service.preview('owner', 'daily', 'source', { ...input, config: { ...input.config, count: 1 } });
    service.start('owner', preview.id); await service.pump(); service.cancel('owner', preview.id);
    expect(released).toBe(1);
  });
  it('비동기 제출 검증이 끝날 때까지 종료를 기다리고 새 작업을 만들지 않는다', async ({ ctx }) => {
    let resolve!: (fn: () => string) => void; let submitted = 0; let stopped = false;
    const adapter: ConfigurationSearchAdapter = { source: () => ({ catalog, request, runtimeIdentity: 'v1' }), sample: () => [{ request, values: { x: 1 } }], runtimeIdentity: () => 'v1', buildSubmission: () => new Promise(r => { resolve = r; }), job: () => null, cancelJob: () => {}, deleteJob: () => {} };
    const service = new ConfigurationSearchService({ database: ctx.container.database, clock: ctx.container.clock, adapters: { daily: adapter, intraday: adapter }, onFinished: () => {}, collectPreparations: () => {} });
    const preview = service.preview('owner', 'daily', 'source', { ...input, config: { ...input.config, count: 1 } });
    expect(preview.config).toEqual({ ...input.config, count: 1 });
    service.start('owner', preview.id);
    const pending = service.pump();
    expect(service.pump()).toBe(pending);
    const stopping = service.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    resolve(() => { submitted++; return 'job'; });
    await stopping;
    expect(submitted).toBe(0); expect(service.get('owner', preview.id).items[0]?.status).toBe('PENDING');
  });
  it('알림 실패 후 재시도하며 성공한 알림은 중복하지 않는다', async ({ ctx }) => {
    let notifications = 0;
    const adapter: ConfigurationSearchAdapter = { source: () => ({ catalog, request, runtimeIdentity: 'v1' }), sample: () => [{ request, values: { x: 1 } }], runtimeIdentity: () => 'v1', buildSubmission: async () => () => 'job', job: () => ({ status: 'COMPLETED', error: null, metrics: null }), cancelJob: () => {}, deleteJob: () => {} };
    const service = new ConfigurationSearchService({ database: ctx.container.database, clock: ctx.container.clock, adapters: { daily: adapter, intraday: adapter }, onFinished: () => { notifications++; if (notifications === 1) throw new Error('notification unavailable'); }, collectPreparations: () => {} });
    const preview = service.preview('owner', 'daily', 'source', { ...input, config: { ...input.config, count: 1 } });
    service.start('owner', preview.id); await service.pump();
    await expect(service.pump()).rejects.toThrow('notification unavailable');
    await service.pump(); await service.pump();
    expect(notifications).toBe(2);
  });
  it('재시작과 용량 대기 뒤에도 원래 조합을 한 번씩 제출한다', async ({ ctx }) => {
    let capacity = false; let submitted = 0;
    const sample = vi.fn(() => [1, 2].map(x => ({ request: { ...request, parameters: { x } }, values: { x } })));
    const adapter: ConfigurationSearchAdapter = { source: owner => { if (owner !== 'owner') throw new ConfigurationSearchError('없음', 404); return { catalog, request, runtimeIdentity: 'v1' }; }, sample, runtimeIdentity: () => 'v1', buildSubmission: async () => () => capacity ? `job${++submitted}` : null, job: () => ({ status: 'QUEUED', error: null, metrics: null }), cancelJob: () => {}, deleteJob: () => {} };
    const deps = { database: ctx.container.database, clock: ctx.container.clock, adapters: { daily: adapter, intraday: adapter }, onFinished: () => {}, collectPreparations: () => {} };
    let service = new ConfigurationSearchService(deps);
    const preview = service.preview('owner', 'daily', 'source', input);
    expect(preview.items.map(i => (i.request as BacktestRequest).randomSeed)).toEqual([42, 42]);
    expect(() => service.preview('owner', 'daily', 'source', { ...input, config: { ...input.config, count: 1 } })).toThrowError(ConfigurationSearchError);
    expect(() => service.catalog('other', 'daily', 'source')).toThrowError(ConfigurationSearchError);
    service.start('owner', preview.id); await service.pump();
    service = new ConfigurationSearchService(deps); capacity = true;
    await service.pump(); await service.pump();
    expect(sample).toHaveBeenCalledTimes(1);
    expect(service.get('owner', preview.id).items.map(i => [i.values.x, i.jobId])).toEqual([[1, 'job1'], [2, 'job2']]);
  });
  it('비동기 검증 중 취소하면 제출하지 않고 오래된 준비 참조는 재시도한다', async ({ ctx }) => {
    let resolve!: (fn: () => string) => void; let mode = 'stale'; let submitted = 0;
    const adapter: ConfigurationSearchAdapter = { source: () => ({ catalog, request, runtimeIdentity: 'v1' }), sample: () => [{ request, values: { x: 1 } }], runtimeIdentity: () => 'v1', prepare: () => { if (mode === 'stale') { mode = 'wait'; throw new PreparationReferenceError(); } return { preparationJobId: null, ready: true }; }, buildSubmission: () => new Promise(r => { resolve = r; }), job: () => null, cancelJob: () => {}, deleteJob: () => {} };
    const service = new ConfigurationSearchService({ database: ctx.container.database, clock: ctx.container.clock, adapters: { daily: adapter, intraday: adapter }, onFinished: () => {}, collectPreparations: () => {} });
    const preview = service.preview('owner', 'daily', 'source', { ...input, config: { ...input.config, count: 1 } });
    service.start('owner', preview.id); await service.pump();
    expect(service.get('owner', preview.id).items[0]?.status).toBe('PENDING');
    const pending = service.pump(); service.cancel('owner', preview.id); resolve(() => { submitted++; return 'job'; }); await pending;
    expect(submitted).toBe(0); expect(service.get('owner', preview.id).status).toBe('CANCELLED');
  });
});
