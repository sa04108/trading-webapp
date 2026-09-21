import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { describe, expect, vi } from 'vitest';
import { test as base } from '../helpers/test-fixtures.js';
import type { TestApp } from '../helpers/test-app.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars } from '../helpers/seed.js';
import * as resources from '../../src/agent/resources.js';
import { LOCAL_AGENT_ID } from '../../src/shared/agent-protocol.js';
import type { PreparationInput } from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { AgentLease, DatasetManifest, ServerAgentMessage } from '../../src/shared/agent-protocol.js';

const GIB = 1024 ** 3;
const input: PreparationInput = {
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'DAY', value: 1 } },
  period: { from: '2026-01-05', to: '2026-01-05' }, strategyId: 'range-breakout', parameters: {},
};
const request: BacktestRequest = {
  ...input, capital: { initialCash: 1_000_000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'zero-cost', slippageProfileId: 'zero-slippage' },
  risk: { maxPositions: 1 }, randomSeed: 1,
};
const schedule = [{ rebalanceDate: '2026-01-05', effectiveTradingDate: '2026-01-05', symbols: ['005930'],
  members: [{ symbol: '005930', standardCode: 'KR7005930003', marketCapKrw: '1000000000', volume: null, tradingValueKrw: null }], excludedNonTradingCount: 0 }];

class Peer extends EventEmitter {
  readyState = 1;
  readonly received: ServerAgentMessage[] = [];
  send(value: string) { this.received.push(JSON.parse(value) as ServerAgentMessage); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  submit(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  jobs(): AgentLease[] { return this.received.filter((m) => m.type === 'JOB').map((m) => m.lease); }
}

interface Scenario {
  readonly ctx: TestApp;
  setLocalAvailable(value: boolean): void;
  connect(slots: number): Promise<{ peer: Peer; id: string; dataset: DatasetManifest }>;
  finished(jobId: string): Promise<void>;
}

const agentBase = base.extend({ appOptions: { agentPreparation: true } });
const it = agentBase.extend<{ scenario: Scenario }>({
  scenario: async ({ ctx }, use) => {
    let localAvailable = true;
    // 이 통합 검사는 tsx 자식의 배정 계약을 검증한다. 1 GB 배포 예산은 자원 단위 검사와
    // compiled 서버의 cgroup 검증에서 확인하며 개발용 TS 로더 메모리는 그 예산에 섞지 않는다.
    vi.spyOn(resources, 'availableServerResources').mockImplementation((running, observed, profiled, requestedBars) =>
      resources.calculateResources({ cpus: 2, total: 4 * GIB, available: localAvailable ? 3 * GIB : GIB, load: 0 }, running, observed, profiled, requestedBars, true));
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [{ standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '1000000000' }]);
    registerSymbols(ctx.container, 'KR', ['005930']);
    seedDailyBars(ctx.container.database.db, [{ symbol: '005930', market: 'KR', timeframe: '1d', tsMs: Date.parse('2026-01-05T00:00:00Z'), open: 100, high: 110, low: 90, close: 105, volume: 1000 }]);
    await seedCorporateActionCoverage(ctx.container, ['005930'], [2024, 2025, 2026]);
    try {
      await use({
        ctx,
        setLocalAvailable(value) { localAvailable = value; },
        async connect(slots) {
          const peer = new Peer();
          const coordinator = ctx.container.agentCoordinator;
          const { id } = coordinator.registry.issue('remote');
          const dataset = await coordinator.snapshots.ensureLatest();
          coordinator.connect(id, peer as unknown as WebSocket);
          peer.submit({ type: 'HELLO', protocolVersion: 3, runnerVersion: coordinator.runnerVersion });
          await vi.waitFor(() => expect(peer.received.some((m) => m.type === 'DATASET')).toBe(true));
          peer.submit({ type: 'CAPACITY', slots, datasetVersion: dataset.version, maxBars: 8_000_000 });
          await new Promise((resolve) => setImmediate(resolve));
          return { peer, id, dataset };
        },
        async finished(jobId) {
          await vi.waitFor(() => expect(ctx.container.jobQueue.getJob(jobId)?.status).toMatch(/COMPLETED|FAILED|CANCELLED/), { timeout: 60_000, interval: 50 });
          expect(ctx.container.jobQueue.getJob(jobId)).toMatchObject({ status: 'COMPLETED', error: null, agentId: LOCAL_AGENT_ID, attempt: 1 });
          // 작업 상태는 결과 import 자식이 먼저 확정하고, 감사 기록은 부모가 종료 응답을 받은 뒤 남긴다.
          await vi.waitFor(() => {
            const event = ctx.container.database.sqlite.prepare("SELECT detail_json AS detail FROM audit_logs WHERE event = 'backtest.finished' AND json_extract(detail_json, '$.jobId') = ? ORDER BY id DESC LIMIT 1").get(jobId) as { detail: string } | undefined;
            expect(event).toBeDefined();
            expect(JSON.parse(event!.detail)).toMatchObject({ executionMode: 'local' });
          }, { timeout: 5000 });
        },
      });
    } finally {
      await ctx.close();
      vi.restoreAllMocks();
    }
  },
});

describe('유휴 에이전트 우선과 즉시 로컬 실행', () => {
  it('두 작업을 한 로컬 워커씩 순서대로 완료하고 HTTP 응답을 유지한다', { timeout: 90_000 }, async ({ scenario }) => {
    const { ctx, finished } = scenario;
    ctx.container.agentCoordinator.start();
    await ctx.container.agentCoordinator.snapshots.ensureLatest();
    const first = ctx.container.jobQueue.enqueue(request, schedule);
    const second = ctx.container.jobQueue.enqueue(request, schedule);
    const probes: Array<Promise<void>> = [];
    const statuses: number[] = [];
    let maxRunning = 0;
    const sample = setInterval(() => {
      const row = ctx.container.database.sqlite.prepare(
        "SELECT COUNT(*) AS n FROM backtest_jobs WHERE status IN ('STARTING', 'RUNNING', 'CANCELLING')",
      ).get() as { n: number };
      maxRunning = Math.max(maxRunning, row.n);
      probes.push(ctx.app.inject({ method: 'GET', url: '/health/ready' }).then((response) => {
        statuses.push(response.statusCode);
      }));
    }, 50);
    try {
      await finished(first.id);
      await finished(second.id);
    } finally {
      clearInterval(sample);
      await Promise.all(probes);
    }
    expect(maxRunning).toBe(1);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => status === 200)).toBe(true);
    for (const job of [first, second])
      expect(ctx.container.database.sqlite.prepare('SELECT job_id FROM backtest_runs WHERE job_id = ?').get(job.id)).toEqual({ job_id: job.id });
    expect(ctx.container.agentCoordinator.registry.list()).toEqual([]);
  });

  it('에이전트 없이 미리보기를 서버 본체 대신 실제 자식 프로세스에서 완료한다', { timeout: 90_000 }, async ({ scenario }) => {
    const { ctx } = scenario;
    const resolver = vi.spyOn(ctx.container.universeRuleResolver, 'resolveOrDescribeNeeds');
    ctx.container.agentCoordinator.start();
    await ctx.container.agentCoordinator.snapshots.ensureLatest();
    const preparation = ctx.container.backtestPreparationOrchestrator.start(input);
    await vi.waitFor(() => expect(ctx.container.backtestPreparationOrchestrator.get(preparation.id)?.status).toBe('RUNNING'), { timeout: 1500 });
    await vi.waitFor(() => expect(ctx.container.backtestPreparationOrchestrator.get(preparation.id)?.status).toBe('COMPLETED'), { timeout: 60_000 });
    expect(ctx.container.database.sqlite.prepare('SELECT client_id FROM agent_preparation_leases WHERE job_id = ?').get(preparation.id)).toEqual({ client_id: LOCAL_AGENT_ID });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('원격이 바쁘면 새 작업만 로컬에서 실행하고 단절된 기존 리스는 건드리지 않는다', { timeout: 90_000 }, async ({ scenario }) => {
    const { ctx, connect, finished } = scenario;
    ctx.container.agentCoordinator.start();
    const { peer, id } = await connect(1);
    const remote = ctx.container.jobQueue.enqueue(request, schedule);
    await vi.waitFor(() => expect(peer.jobs()[0]?.jobId).toBe(remote.id));
    const local = ctx.container.jobQueue.enqueue({ ...request, randomSeed: 2 }, schedule);
    await vi.waitFor(() => expect(ctx.container.jobQueue.getJob(local.id)?.agentId).toBe(LOCAL_AGENT_ID), { timeout: 1500 });
    peer.close();
    await finished(local.id);
    expect(ctx.container.jobQueue.getJob(remote.id)).toMatchObject({ agentId: id, status: 'STARTING', attempt: 1 });
    expect(peer.jobs()).toHaveLength(1);
  });

  it('서버에도 자원이 없으면 큐에 두고 원격 슬롯이 생기는 즉시 배정한다', async ({ scenario }) => {
    const { ctx, connect, setLocalAvailable } = scenario;
    setLocalAvailable(false);
    const { peer, id, dataset } = await connect(0);
    ctx.container.agentCoordinator.start();
    const job = ctx.container.jobQueue.enqueue(request, schedule);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('QUEUED');
    peer.submit({ type: 'CAPACITY', slots: 1, datasetVersion: dataset.version, maxBars: 8_000_000 });
    await vi.waitFor(() => expect(peer.jobs()[0]?.jobId).toBe(job.id), { timeout: 500 });
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({ agentId: id, attempt: 1 });
  });

  it('로컬 실행 중 원격이 연결되면 대기 작업을 원격에 주고 진행 중 로컬 작업은 유지한다', { timeout: 90_000 }, async ({ scenario }) => {
    const { ctx, connect, finished, setLocalAvailable } = scenario;
    ctx.container.agentCoordinator.start();
    await ctx.container.agentCoordinator.snapshots.ensureLatest();
    const first = ctx.container.jobQueue.enqueue(request, schedule);
    await vi.waitFor(() => expect(ctx.container.jobQueue.getJob(first.id)?.agentId).toBe(LOCAL_AGENT_ID));
    setLocalAvailable(false);
    const second = ctx.container.jobQueue.enqueue({ ...request, randomSeed: 2 }, schedule);
    const { peer, id } = await connect(1);
    await vi.waitFor(() => expect(peer.jobs()[0]?.jobId).toBe(second.id), { timeout: 500 });
    await finished(first.id);
    expect(ctx.container.jobQueue.getJob(second.id)).toMatchObject({ agentId: id, attempt: 1 });
  });
  it('로컬 자식의 입력 파일을 열 수 없으면 해당 작업만 실패하고 서버는 계속 동작한다', { timeout: 60_000 }, async ({ scenario }) => {
    const { ctx } = scenario;
    await ctx.container.agentCoordinator.snapshots.ensureLatest();
    vi.spyOn(ctx.container.agentCoordinator.snapshots, 'file').mockReturnValue(`${ctx.dir}/missing.sqlite`);
    ctx.container.agentCoordinator.start();
    const job = ctx.container.jobQueue.enqueue(request, schedule);
    await vi.waitFor(() => expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('FAILED'), { timeout: 3000 });
    expect(ctx.container.jobQueue.getJob(job.id)?.error).toBeTruthy();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/agents/datasets/1' })).statusCode).toBe(401);
  });

});
