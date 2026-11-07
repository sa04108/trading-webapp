import path from 'node:path';
import { describe, expect, vi } from 'vitest';
import { AgentClient } from '../../src/agent/client.js';
import { AgentUniverseTasks } from '../../src/agent/universe-tasks.js';
import type { PreparationInput } from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';
import type { UniverseComputeReply } from '../../src/shared/universe-compute.js';
import { seedCorporateActionCoverage, registerSymbols, seedDailyBars } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { test as base } from '../helpers/test-fixtures.js';

const input: PreparationInput = {
  universeRule: {
    markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  },
  period: { from: '2024-01-01', to: '2025-01-01' }, strategyId: 'range-breakout', parameters: {},
};

async function waitUntil(read: () => boolean, timeout = 60_000): Promise<void> {
  const start = Date.now();
  while (!read()) {
    if (Date.now() - start > timeout) throw new Error('에이전트 작업 대기 시간 초과');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const it = base.extend({ appOptions: { agentPreparation: true } });

describe('분산 유니버스 준비', () => {
  it('두 에이전트가 실제 보조 프로세스를 거쳐 월별 결과를 합친다', { timeout: 120_000 }, async ({ ctx }) => {
    const dates: string[] = [];
    for (let ts = Date.parse('2023-10-02T00:00:00Z'); ts <= Date.parse('2025-01-01T00:00:00Z'); ts += 86_400_000) {
      const date = new Date(ts);
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
    }
    seedSymbolMasterUniverse(ctx.container, dates, [{
      standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '1000000000',
    }]);
    registerSymbols(ctx.container, 'KR', ['005930']);
    seedDailyBars(ctx.container.database.db, dates.map((date) => ({
      symbol: '005930', market: 'KR', timeframe: '1d', tsMs: Date.parse(`${date}T00:00:00Z`),
      open: 100, high: 110, low: 90, close: 105, volume: 1000,
    })));
    await seedCorporateActionCoverage(ctx.container, ['005930'], [2023, 2024, 2025, 2026]);
    const serverResolver = vi.spyOn(ctx.container.universeRuleResolver, 'resolveOrDescribeNeeds');
    const helperDispatch = vi.spyOn(AgentUniverseTasks.prototype, 'start');
    const helperReply = vi.spyOn(AgentUniverseTasks.prototype as unknown as {
      reply(task: unknown, reply: UniverseComputeReply): void;
    }, 'reply');
    let second: AgentClient | undefined;
    try {
      await ctx.startAgent();
      const address = ctx.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('서버 주소가 없습니다');
      const credential = ctx.container.agentCoordinator.registry.issue('second-integration-agent');
      second = new AgentClient({ serverUrl: `http://127.0.0.1:${address.port}`, token: credential.token },
        path.join(ctx.dir, 'second-agent'), undefined, () => undefined);
      second.start();
      const coordinator = ctx.container.agentCoordinator as unknown as {
        connections: Map<string, { ready: boolean; datasetVersion: number; slots: number }>;
      };
      await waitUntil(() => {
        const dataset = ctx.container.agentCoordinator.snapshots.latest();
        const connections = [...coordinator.connections.values()];
        return dataset !== null && connections.length === 2 && connections.every((connection) =>
          connection.ready && connection.slots > 0 && connection.datasetVersion === dataset.version);
      });
      const job = ctx.container.backtestPreparationOrchestrator.start(input);
      await waitUntil(() => ctx.container.backtestPreparationOrchestrator.isTerminal(
        ctx.container.backtestPreparationOrchestrator.get(job.id)!.status,
      ), 100_000);
      expect(ctx.container.backtestPreparationOrchestrator.get(job.id)).toMatchObject({ status: 'COMPLETED', error: null });
      expect(helperDispatch).toHaveBeenCalled();
      expect(helperReply.mock.calls.some(([, reply]) => reply.status === 'COMPLETED')).toBe(true);
      expect(serverResolver).not.toHaveBeenCalled();
      const preview = ctx.container.backtestPreparationOrchestrator.getFreshPreviewDetails(input)?.preview;
      expect(preview?.unionSymbols).toEqual(['005930']);
      expect(preview?.schedule).toHaveLength(13);
      expect(preview?.schedule.every((row) => row.members.map((member) => member.symbol).join(',') === '005930')).toBe(true);
    } finally {
      await second?.stop();
      vi.restoreAllMocks();
    }
  });
});
