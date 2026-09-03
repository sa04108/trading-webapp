import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

async function login(ctx: TestApp, username: string, password: string): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.find((cookie) => cookie.name === 'qp_session')!.value;
}

describe('backtest wizard draft routes', () => {
  let ctx: TestApp;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    const admin = await createTestAdmin(ctx.container);
    cookie = await login(ctx, admin.username, admin.password);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('requires authentication for reading, saving, and clearing drafts', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/v1/backtests/wizard-draft', undefined],
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

  it('persists each validated step independently', async () => {
    const payloads = {
      strategy: { strategyId: 'range-breakout', parameters: { lookbackBars: '17' } },
      period: {
        from: '2026-01-05',
        to: '2026-03-31',
        benchmarkId: 'KOSPI',
        benchmarkCoverageVerifiedFor: 'KOSPI:2026-01-05:2026-03-31',
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
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
        randomSeed: '99',
      },
    } as const;

    for (const [step, payload] of Object.entries(payloads)) {
      const saved = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/backtests/wizard-draft/${step}`,
        cookies: { qp_session: cookie },
        payload,
      });
      expect(saved.statusCode, step).toBe(200);
      expect(saved.json().draft).toMatchObject({ step, payload });

      const loaded = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/backtests/wizard-draft/${step}`,
        cookies: { qp_session: cookie },
      });
      expect(loaded.statusCode, step).toBe(200);
      expect(loaded.json().draft).toMatchObject({ step, payload });
      expect(loaded.json().draft.updatedAtMs).toEqual(expect.any(Number));
    }
  });

  it('separates new and clone contexts and clears only the requested context', async () => {
    const newPayload = { strategyId: 'range-breakout', parameters: { lookbackBars: '17' } };
    const clonePayload = { strategyId: 'range-breakout', parameters: { lookbackBars: '33' } };
    for (const [query, payload] of [
      ['', newPayload],
      ['?sourceJobId=bt_source', clonePayload],
    ] as const) {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/backtests/wizard-draft/strategy${query}`,
        cookies: { qp_session: cookie },
        payload,
      });
      expect(response.statusCode).toBe(200);
    }

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/backtests/wizard-draft',
      cookies: { qp_session: cookie },
    });
    expect(removed.statusCode).toBe(204);

    const fresh = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft/strategy',
      cookies: { qp_session: cookie },
    });
    expect(fresh.json()).toEqual({ draft: null });
    const clone = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft/strategy?sourceJobId=bt_source',
      cookies: { qp_session: cookie },
    });
    expect(clone.json().draft.payload).toEqual(clonePayload);
  });

  it('returns the latest unfinished context and can clear every context explicitly', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/strategy',
      cookies: { qp_session: cookie },
      payload: { strategyId: 'range-breakout', parameters: {}, currentStep: 'period' },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/strategy?sourceJobId=bt_source',
      cookies: { qp_session: cookie },
      payload: { strategyId: 'range-breakout', parameters: {}, currentStep: 'review' },
    });

    const candidate = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft',
      cookies: { qp_session: cookie },
    });
    expect(candidate.statusCode).toBe(200);
    expect(candidate.json().candidate).toMatchObject({
      sourceJobId: 'bt_source',
      currentStep: 'review',
      updatedAtMs: expect.any(Number),
    });

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/backtests/wizard-draft?all=true',
      cookies: { qp_session: cookie },
    });
    expect(removed.statusCode).toBe(204);

    const emptyCandidate = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft',
      cookies: { qp_session: cookie },
    });
    expect(emptyCandidate.json()).toEqual({ candidate: null });
    for (const query of ['', '?sourceJobId=bt_source']) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/backtests/wizard-draft/strategy${query}`,
        cookies: { qp_session: cookie },
      });
      expect(response.json()).toEqual({ draft: null });
    }
  });

  it('does not expose another user draft', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/strategy',
      cookies: { qp_session: cookie },
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
      cookies: { qp_session: otherCookie },
    });
    expect(response.json()).toEqual({ draft: null });
    const candidate = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft',
      cookies: { qp_session: otherCookie },
    });
    expect(candidate.json()).toEqual({ candidate: null });
  });

  it('rejects unknown steps and malformed payloads', async () => {
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/wizard-draft/review',
      cookies: { qp_session: cookie },
    });
    expect(unknown.statusCode).toBe(400);

    const malformed = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/backtests/wizard-draft/capital',
      cookies: { qp_session: cookie },
      payload: { initialCash: 1000 },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
