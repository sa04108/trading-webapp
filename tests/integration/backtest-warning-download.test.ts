import { describe, expect } from 'vitest';
import { backtestRuns, backtestWarningDetails } from '../../src/server/shared/db/backtest-result-schema.js';
import type { TestApp } from '../helpers/test-app.js';
import { authenticatedTest as it } from '../helpers/test-fixtures.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';

const request: BacktestRequest = {
  strategyId: 'range-breakout', parameters: {},
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'MONTH', value: 1 } },
  period: { from: '2025-01-01', to: '2026-01-01' },
  capital: { initialCash: 10000000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'zero-cost', slippageProfileId: 'zero-slippage' },
  risk: { maxPositions: 1 }, randomSeed: 42,
};

function result(ctx: TestApp, warnings: string[]) {
  const job = ctx.container.jobQueue.enqueue(request);
  ctx.container.database.db.insert(backtestRuns).values({
    id: `run_${job.id}`, jobId: job.id, strategyId: request.strategyId,
    strategyVersion: '1', strategySourceHash: 'hash', parameterJson: '{}',
    universeRuleJson: job.universeRuleJson, scheduleHash: 'hash', universeHash: 'hash', universeJson: '[]',
    engineVersion: '1', feeModelVersion: '1', slippageModelVersion: '1', randomSeed: 42,
    gitCommitSha: 'test', warningsJson: JSON.stringify(warnings), startedAtMs: 1, completedAtMs: 2,
  }).run();
  return job;
}

describe('결과 경고 원문 다운로드', () => {
  it('로그인한 사용자가 100개씩 읽은 경고 전체를 순서·중복·긴 문자열 그대로 받는다', async ({ ctx, cookie }) => {
    const warnings = Array.from({ length: 1093 }, (_, index) => `경고 ${index}`);
    warnings[317] = '자'.repeat(4162);
    warnings[318] = warnings[317]!;
    warnings[1092] = '줄바꿈\n따옴표 "원문" 😀';
    const job = result(ctx, ['표시 요약']);
    ctx.container.database.db.insert(backtestWarningDetails)
      .values(warnings.map((warning, sequence) => ({ jobId: job.id, sequence, warning }))).run();
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/${job.id}/warnings`, cookies: { session: cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.json()).toEqual({ warnings });
  });

  it('기존 결과는 보관된 warningsJson을 원문으로 반환한다', async ({ ctx, cookie }) => {
    const warnings = ['기존 경고', '기존 경고'];
    const job = result(ctx, warnings);
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/${job.id}/warnings`, cookies: { session: cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ warnings });
  });

  it('로그인하지 않은 다운로드를 차단한다', async ({ ctx }) => {
    const job = result(ctx, ['경고']);
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/${job.id}/warnings` });
    expect(response.statusCode).toBe(401);
  });

  it('없는 작업과 아직 결과가 없는 작업은 다운로드하지 않는다', async ({ ctx, cookie }) => {
    const job = ctx.container.jobQueue.enqueue(request);
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/backtests/missing/warnings', cookies: { session: cookie } });
    const pending = await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/${job.id}/warnings`, cookies: { session: cookie } });
    expect(missing.statusCode).toBe(404);
    expect(pending.statusCode).toBe(409);
  });

  it('다운로드를 읽는 사이에도 같은 DB 연결에서 쓰기를 계속할 수 있다', async ({ ctx }) => {
    const job = result(ctx, ['표시 요약']);
    ctx.container.database.db.insert(backtestWarningDetails).values([
      { jobId: job.id, sequence: 0, warning: '첫 원문' },
      { jobId: job.id, sequence: 1, warning: '다음 원문' },
    ]).run();
    const warnings = ctx.container.resultsService.iterateWarningDetails(job.id);
    expect(warnings.next().value).toBe('첫 원문');
    expect(() => ctx.container.database.sqlite.prepare('UPDATE backtest_runs SET git_commit_sha = ? WHERE job_id = ?').run('updated', job.id)).not.toThrow();
    expect([...warnings]).toEqual(['다음 원문']);
  });
});
