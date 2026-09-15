import { readRuntimeVersions, type RuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import { fork } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLease } from '../../src/shared/agent-protocol.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars } from '../helpers/seed.js';
import type { PreparationInput } from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';

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

interface PreparationChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly messages: Array<{ type: string; outcome?: string }>;
}

function runPreparationChild(lease: AgentLease, jobPath: string, dataPath: string, sourceVersions?: RuntimeVersions): Promise<PreparationChildExit> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  if (sourceVersions) env.QUANT_SOURCE_RUNTIME_VERSIONS = JSON.stringify(sourceVersions);
  const child = fork(new URL('../../src/runtime/workers/preparation-child.ts', import.meta.url), [], {
    env,
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  return new Promise((resolve) => {
    let stderr = '';
    const messages: PreparationChildExit['messages'] = [];
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
    child.on('error', (error) => { stderr = (stderr + error.message).slice(-4_000); });
    child.on('message', (message: { type: string; outcome?: string }) => { messages.push(message); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr, messages });
    });
    child.send({ lease, jobPath, dataPath });
  });
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

  it('완료 뒤 IPC를 끊어도 닫힌 작업 DB를 다시 읽지 않고 종료한다', { timeout: 45_000 }, async () => {
    ctx = await createTestApp({}, undefined, true);
    await seed();
    await seedCorporateActionCoverage(ctx.container, ['005930'], [2024, 2025, 2026]);
    const job = ctx.container.backtestPreparationOrchestrator.start(input);
    const manifest = await ctx.container.agentCoordinator.snapshots.ensureLatest();
    const lease = ctx.container.agentCoordinator.preparations.claim('shutdown-regression', manifest);
    expect(lease).not.toBeNull();
    if (!lease) throw new Error('준비 작업 lease를 확보하지 못했습니다');

    const exit = await runPreparationChild(
      lease,
      path.join(ctx.dir, 'preparation-shutdown-regression.sqlite'),
      ctx.container.agentCoordinator.snapshots.file(manifest),
    );

    expect(exit.code, exit.stderr).toBe(0);
    expect(exit.signal, exit.stderr).toBeNull();
    expect(exit.stderr).toBe('');
    expect(exit.messages).toContainEqual(expect.objectContaining({ type: 'FINISH', outcome: 'COMPLETED' }));
    expect(ctx.container.backtestPreparationOrchestrator.get(job.id)).toMatchObject({ status: 'RUNNING' });
  });

  it('설치된 에이전트의 수집 버전이 오래되어도 lease의 수집 버전으로 준비를 완료한다', { timeout: 45_000 }, async () => {
    ctx = await createTestApp({}, undefined, true);
    await seed();
    await seedCorporateActionCoverage(ctx.container, ['005930'], [2024, 2025, 2026]);
    ctx.container.backtestPreparationOrchestrator.start(input);
    const manifest = await ctx.container.agentCoordinator.snapshots.ensureLatest();
    const lease = ctx.container.agentCoordinator.preparations.claim('old-collection-metadata', manifest);
    if (!lease) throw new Error('준비 작업 lease를 확보하지 못했습니다');
    const oldAgentVersions = { ...readRuntimeVersions(), collectionVersion: 'a'.repeat(64) };
    expect(lease.dataset.collectionVersion).not.toBe(oldAgentVersions.collectionVersion);
    const exit = await runPreparationChild(
      lease,
      path.join(ctx.dir, 'old-collection-metadata.sqlite'),
      ctx.container.agentCoordinator.snapshots.file(manifest),
      oldAgentVersions,
    );
    expect(exit.code, exit.stderr).toBe(0);
    expect(exit.messages).not.toContainEqual(expect.objectContaining({ type: 'NEEDS_DATA' }));
    expect(exit.messages).toContainEqual(expect.objectContaining({ type: 'FINISH', outcome: 'COMPLETED' }));
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
