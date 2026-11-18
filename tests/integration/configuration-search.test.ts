import { describe, expect } from 'vitest';
import { authenticatedTest as it } from '../helpers/test-fixtures.js';
import { createTestAdmin } from '../helpers/test-app.js';
import { intradayRuns } from '../../src/server/shared/db/intraday-schema.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { IntradayRequest } from '../../src/shared/schemas/intraday.js';

const daily: BacktestRequest = { strategyId: 'range-breakout', parameters: {}, universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 20 }], rebalanceInterval: { unit: 'NONE', value: 1 } }, period: { from: '2025-01-01', to: '2025-03-01' }, capital: { initialCash: 10000000, currency: 'KRW' }, execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'kr-equity-default', slippageProfileId: 'fixed-5bps' }, risk: { maxPositions: 20 }, randomSeed: 42 };
const intraday: IntradayRequest = { mode: 'intraday', strategyId: 'intraday-ema', symbol: '005930', period: { from: '2025-01-01', to: '2025-01-02' }, timeframe: '15m', initialCash: 100000, parameters: { fast: 2, slow: 5, volumePeriod: 4, volumeMultiplier: 1.3, maxDailyEntries: 2, cooldownMinutes: 30, maxHoldingMinutes: 120, allocationPct: 95, stopLossPct: 3, takeProfitPct: 6 }, execution: { holdingPolicy: 'DAY_ONLY', commissionBps: 1, taxBps: 1, slippageBps: 1, latencyMs: 1000, orderExpiryMinutes: 3, maxParticipationPct: 10 } };

describe('configuration search HTTP', () => {
  it('폐기한 난수 복제 API와 갱신 우회 요청을 거부하며 새 작업을 만들지 않는다', async ({ ctx, cookie }) => {
    const source = ctx.container.jobQueue.enqueue(daily);
    ctx.container.jobQueue.setStatus(source.id, 'COMPLETED', {}, ['QUEUED']);
    const direct = await ctx.app.inject({ method: 'POST', url: `/api/v1/backtests/${source.id}/clone-random-seeds`, cookies: { session: cookie }, payload: { count: 3 } });
    expect(direct.statusCode, direct.body).toBe(404);
    const refresh = await ctx.app.inject({ method: 'POST', url: `/api/v1/backtests/${source.id}/refresh-and-run`, cookies: { session: cookie }, payload: { requestId: crypto.randomUUID(), action: { kind: 'RANDOM_SEEDS', count: 3 } } });
    expect(refresh.statusCode, refresh.body).toBe(400);
    expect(ctx.container.database.sqlite.prepare('SELECT count(*) AS count FROM backtest_refresh_jobs').get()).toEqual({ count: 0 });
    for (const [method, url] of [['GET', '/api/v1/backtest-clone-batches'], ['GET', '/api/v1/backtest-clone-batches/legacy'], ['POST', '/api/v1/backtest-clone-batches/legacy/cancel'], ['DELETE', '/api/v1/backtest-clone-batches/legacy']] as const) {
      const response = await ctx.app.inject({ method, url, cookies: { session: cookie } });
      expect(response.statusCode, response.body).toBe(404);
    }
    expect(ctx.container.database.sqlite.prepare('SELECT id FROM backtest_jobs').all()).toEqual([{ id: source.id }]);
    const reference = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/api-reference', cookies: { session: cookie } });
    expect(reference.statusCode).toBe(200);
    expect(reference.body).not.toContain('clone-random-seeds');
    expect(reference.body).not.toContain('RANDOM_SEEDS');
    expect(reference.body).toContain('configuration-search');
  });

  it('인증과 카탈로그, 영속 미리보기의 멱등성과 입력 검증을 보장한다', async ({ ctx, cookie, admin }) => {
    const source = ctx.container.jobQueue.enqueue(daily);
    ctx.container.jobQueue.setStatus(source.id, 'COMPLETED', {}, ['QUEUED']);
    const base = `/api/v1/backtests/${source.id}/configuration-search`;
    const auth = { session: cookie };
    for (const url of [`${base}/catalog`, base, '/api/v1/system/api-reference', '/api/v1/configuration-searches/missing']) {
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    for (const url of [`${base}/preview`, '/api/v1/configuration-searches/missing/start', '/api/v1/configuration-searches/missing/cancel']) {
      expect((await ctx.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    }
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/v1/configuration-searches/missing' })).statusCode).toBe(401);
    const catalogResponse = await ctx.app.inject({ method: 'GET', url: `${base}/catalog`, cookies: auth });
    expect(catalogResponse.statusCode, catalogResponse.body).toBe(200);
    const fields = catalogResponse.json().catalog.fields as Array<{ key: string; min?: number }>;
    expect(fields.find(f => f.key === 'parameters.stopAtrMultiplier')?.min).toBe(0.01);
    expect(fields.map(f => f.key)).toContain('universeRule.stages.0.limit');
    expect(fields.map(f => f.key)).toContain('randomSeed');
    const input = { requestId: '123e4567-e89b-42d3-a456-426614174000', config: { count: 2, settings: { 'parameters.lookbackBars': { kind: 'RANGE', min: 10, max: 11 } } } };
    const post = (payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: `${base}/preview`, cookies: auth, payload });
    const first = await post(input); expect(first.statusCode, first.body).toBe(201);
    const experiment = first.json().experiment;
    expect(experiment.status).toBe('PREVIEW'); expect(experiment.items).toHaveLength(2);
    const listing = await ctx.app.inject({ method: 'GET', url: base, cookies: auth });
    expect(listing.json().experiments.map((item: { id: string }) => item.id)).toContain(experiment.id);
    const extra = await post({ ...input, requestId: crypto.randomUUID() });
    expect(extra.statusCode, extra.body).toBe(201);
    const extraId = extra.json().experiment.id;
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/configuration-searches/${extraId}`, cookies: auth })).statusCode).toBe(204);
    const afterDelete = await ctx.app.inject({ method: 'GET', url: base, cookies: auth });
    expect(afterDelete.json().experiments.map((item: { id: string }) => item.id)).not.toContain(extraId);
    expect((await post(input)).json().experiment.items).toEqual(experiment.items);
    expect((await post({ ...input, config: { ...input.config, count: 1 } })).statusCode).toBe(409);
    for (const [key, min, max] of [['period.from', 1, 2], ['parameters.lookbackBars', 1, 2]] as const) {
      const invalid = await post({ requestId: crypto.randomUUID(), config: { count: 1, settings: { [key]: { kind: 'RANGE', min, max } } } });
      expect(invalid.statusCode, invalid.body).toBe(422);
    }
    expect(ctx.container.jobQueue.getJob(source.id)?.requestJson).toBe(source.requestJson);
    const other = await createTestAdmin(ctx.container, { username: 'search-other' });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: other.username, password: other.password } });
    const otherCookie = login.cookies.find(c => c.name === 'session')!.value;
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/configuration-searches/${experiment.id}`, cookies: { session: otherCookie } })).statusCode).toBe(404);
    const startUrl = `/api/v1/configuration-searches/${experiment.id}/start`;
    const started = await ctx.app.inject({ method: 'POST', url: startUrl, cookies: auth });
    const repeated = await ctx.app.inject({ method: 'POST', url: startUrl, cookies: auth });
    expect(started.statusCode, started.body).toBe(202); expect(repeated.statusCode, repeated.body).toBe(202);
    expect(repeated.json().experiment.id).toBe(experiment.id);
    expect(repeated.json().experiment.items.map((item: { id: string }) => item.id)).toEqual(experiment.items.map((item: { id: string }) => item.id));
    const jobs = await ctx.app.inject({ method: 'GET', url: '/api/v1/jobs', cookies: auth });
    expect(jobs.json().jobs.map((job: { id: string }) => job.id)).toContain(`configuration-search:${experiment.id}`);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/configuration-searches/${experiment.id}/cancel`, cookies: auth })).statusCode).toBe(200);
    const ownerId = ctx.container.userRepository.findByUsername(admin.username)!.id;
    ctx.container.database.db.insert(intradayRuns).values({ id: 'intraday-source', ownerId, status: 'COMPLETED', requestJson: JSON.stringify(intraday), createdAtMs: 1, updatedAtMs: 1 }).run();
    const intradayUrl = '/api/v1/intraday/runs/intraday-source/configuration-search/catalog';
    const intra = await ctx.app.inject({ method: 'GET', url: intradayUrl, cookies: auth });
    expect(intra.statusCode, intra.body).toBe(200);
    const keys = (intra.json().catalog.fields as Array<{ key: string }>).map(f => f.key);
    expect(keys).toContain('parameters.fast'); expect(keys).not.toContain('randomSeed'); expect(keys.some(k => k.startsWith('universeRule.'))).toBe(false);
    expect((await ctx.app.inject({ method: 'GET', url: intradayUrl, cookies: { session: otherCookie } })).statusCode).toBe(404);
  });
});
