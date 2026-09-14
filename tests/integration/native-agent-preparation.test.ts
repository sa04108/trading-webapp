import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars } from '../helpers/seed.js';
import type { PreparationInput } from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';

let ctx: TestApp | undefined;
afterEach(async () => { await ctx?.close(); });
const input: PreparationInput = {
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'DAY', value: 1 } },
  period: { from: '2026-01-05', to: '2026-01-05' }, strategyId: 'range-breakout', parameters: {},
};
async function waitUntil(read: () => boolean, timeout = 60_000): Promise<void> {
  const start = Date.now(); while (!read()) { if (Date.now() - start > timeout) throw new Error('에이전트 작업 대기 시간 초과'); await new Promise((resolve) => setTimeout(resolve, 50)); }
}
async function seed(): Promise<void> {
  seedSymbolMasterUniverse(ctx!.container, ['2026-01-05'], [{ standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '1000000000' }]);
  registerSymbols(ctx!.container, 'KR', ['005930']);
  seedDailyBars(ctx!.container.database.db, [{ symbol: '005930', market: 'KR', timeframe: '1d', tsMs: Date.parse('2026-01-05T00:00:00Z'), open: 100, high: 110, low: 90, close: 105, volume: 1000 }]);
}

describe('Linux 에이전트 유니버스 실행', () => {
  it('운영 서버가 유니버스를 계산하지 않고 에이전트의 검증 결과를 저장한다', { timeout: 90_000 }, async () => {
    ctx = await createTestApp({}, undefined, true);
    await seed(); await seedCorporateActionCoverage(ctx.container, ['005930'], [2024, 2025, 2026]);
    const resolver = vi.spyOn(ctx.container.universeRuleResolver, 'resolveOrDescribeNeeds');
    const job = ctx.container.backtestPreparationOrchestrator.start(input);
    expect(job.status).toBe('QUEUED');
    await ctx.startAgent();
    await waitUntil(() => ctx!.container.backtestPreparationOrchestrator.isTerminal(ctx!.container.backtestPreparationOrchestrator.get(job.id)!.status));
    expect(ctx.container.backtestPreparationOrchestrator.get(job.id)).toMatchObject({ status: 'COMPLETED', error: null });
    expect(ctx.container.backtestPreparationOrchestrator.getFreshPreviewDetails(input)?.preview.unionSymbols).toEqual(['005930']);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('데이터가 부족하면 서버에 수집을 요청하고 새 버전으로 이어가며 실패 횟수를 소비하지 않는다', { timeout: 120_000 }, async () => {
    ctx = await createTestApp({}, undefined, true);
    await seed();
    const collect = vi.spyOn(ctx.container.factSyncService, 'syncCorporateActions').mockImplementation(async (request) => {
      const waiting = ctx!.container.database.sqlite.prepare("SELECT COUNT(*) AS n FROM backtest_preparation_jobs WHERE status = 'WAITING_DATA'").get() as { n: number };
      expect(waiting.n).toBeGreaterThan(0);
      const years = Array.from({ length: request.toYear - request.fromYear + 1 }, (_, index) => request.fromYear + index);
      await seedCorporateActionCoverage(ctx!.container, request.symbols, years);
      return { savedFacts: 0, gapCount: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null };
    });
    const job = ctx.container.backtestPreparationOrchestrator.start(input);
    await ctx.startAgent();
    await waitUntil(() => ctx!.container.backtestPreparationOrchestrator.isTerminal(ctx!.container.backtestPreparationOrchestrator.get(job.id)!.status), 90_000);
    expect(ctx.container.backtestPreparationOrchestrator.get(job.id)).toMatchObject({ status: 'COMPLETED', error: null });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(ctx.container.database.sqlite.prepare('SELECT failures, attempt FROM agent_preparation_leases WHERE job_id = ?').get(job.id)).toMatchObject({ failures: 0, attempt: 2 });
    expect(ctx.container.agentCoordinator.snapshots.latest()!.version).toBeGreaterThan(1);
  });
});
