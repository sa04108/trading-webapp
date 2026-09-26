import { describe, expect, vi } from 'vitest';
import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import { authenticatedTest } from '../helpers/test-fixtures.js';
import * as resources from '../../src/agent/resources.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { ExecutionProgress } from '../../src/shared/execution-progress.js';

const it = authenticatedTest.extend({ appOptions: { agentPreparation: true } });
const MIB = 1024 ** 2;
const request: BacktestRequest = {
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 32 }], rebalanceInterval: { unit: 'DAY', value: 1 } },
  period: { from: '2026-01-05', to: '2026-01-06' }, strategyId: 'ema-trend-switch', parameters: {},
  capital: { initialCash: 1_000_000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'zero-cost', slippageProfileId: 'zero-slippage' },
  risk: { maxPositions: 1 }, randomSeed: 1,
};
const schedule = [{ rebalanceDate: '2026-01-05', effectiveTradingDate: '2026-01-05',
  symbols: Array.from({ length: 32 }, (_, i) => String(i).padStart(6, '0')),
  members: [], excludedNonTradingCount: 0 }];

function localResources(budgetBytes: number, slots = 1) {
  return { cpus: 2, availableBytes: budgetBytes, reserveBytes: 128 * MIB,
    slots, heapMb: 128, maxBars: 2_000_000, budgetBytes, memoryPressure: false };
}

describe('배정 준비 진행 정보', () => {
  it('연결된 실행기가 없으면 실제 대기 사유를 API에 보내고 진행률은 만들지 않는다', async ({ ctx, cookie }) => {
    const job = ctx.container.jobQueue.enqueue(request, schedule);
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/${job.id}`, cookies: { session: cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().job.progress).toMatchObject({ activity: 'WAITING_FOR_EXECUTOR', completed: null, total: null });
    expect(response.json().job.progress.detail).toContain('연결된 실행기가 없습니다');
  });

  it('종목별 메모리 집계를 알리고 같은 API 행에서도 진행 revision을 갱신한다', async ({ ctx, cookie }) => {
    const coordinator = ctx.container.agentCoordinator;
    vi.spyOn(resources, 'availableServerResources').mockReturnValue(localResources(256 * MIB));
    // 실제 집계까지 실행하되 자식 실행은 이 관측 검사 범위에서 제외한다.
    vi.spyOn(coordinator.backtests, 'claim').mockReturnValue({ status: 'EMPTY' });
    const job = ctx.container.jobQueue.enqueue(request, schedule);
    const get = () => ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/${job.id}`, cookies: { session: cookie } });
    const before = (await get()).json().job;
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const streamAbort = new AbortController();
    const streamTimeout = setTimeout(() => streamAbort.abort(), 5000);
    const stream = await fetch(`${address}/api/v1/backtests/${job.id}/events`, {
      headers: { cookie: `session=${cookie}` }, signal: streamAbort.signal,
    });
    const reader = stream.body!.getReader();
    let events = '';
    const readProgress = async () => {
      while (!events.includes('"completed":32')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('종목별 집계 전에 SSE가 종료되었습니다');
        events += new TextDecoder().decode(chunk.value);
      }
    };
    const other = ctx.container.jobQueue.enqueue(request, schedule);
    const otherObserved: ExecutionProgress[] = [];
    const observed: ExecutionProgress[] = [];
    const listener = ({ jobId }: { jobId: string }) => {
      if (jobId !== job.id) return;
      const progress = coordinator.backtestProgress(ctx.container.jobQueue.getJob(job.id)!);
      if (progress) observed.push(progress);
      if (progress?.activity === 'ESTIMATING_JOB_MEMORY') {
        otherObserved.push(coordinator.backtestProgress(ctx.container.jobQueue.getJob(other.id)!)!);
      }
    };
    ctx.container.jobQueue.events.on('job', listener);
    try {
      coordinator.start();
      await vi.waitFor(() => expect(observed).toEqual(expect.arrayContaining([
        expect.objectContaining({ activity: 'ESTIMATING_JOB_MEMORY', unit: 'SYMBOLS', completed: 32, total: 32 }),
      ])));
      await readProgress();
      expect(events).toContain('ESTIMATING_JOB_MEMORY');
      await vi.waitFor(() => expect(coordinator.backtestProgress(ctx.container.jobQueue.getJob(job.id)!)?.activity).toBe('ASSIGNING_EXECUTOR'));
      const after = (await get()).json().job;
      expect(after.status).toBe('QUEUED');
      expect(after.progress).toMatchObject({ activity: 'ASSIGNING_EXECUTOR', completed: null, total: null });
      expect(after.progress.detail).toContain('예상 필요 메모리');
      expect(after.progressRevision).toBeGreaterThan(before.progressRevision);
      expect((await get()).json().job.progressRevision).toBe(after.progressRevision);
      expect(coordinator.backtests.claim).toHaveBeenCalled();
      expect(otherObserved.length).toBeGreaterThan(0);
      for (const progress of otherObserved) {
        expect(progress).toMatchObject({ activity: 'ASSIGNING_EXECUTOR', unit: null, completed: null, total: null });
        expect(progress.detail).toContain('먼저 대기 중인 백테스트');
      }
    } finally {
      clearTimeout(streamTimeout);
      await reader.cancel();
      streamAbort.abort();
      ctx.container.jobQueue.events.off('job', listener);
      await coordinator.stop();
      vi.restoreAllMocks();
    }
  });

  it('최소 메모리 부족을 수치로 표시하고 예산 회복 뒤 팩트 집계를 생략하지 않는다', async ({ ctx }) => {
    const coordinator = ctx.container.agentCoordinator;
    const sample = vi.spyOn(resources, 'availableServerResources').mockReturnValue(localResources(180 * MIB));
    vi.spyOn(coordinator.backtests, 'claim').mockReturnValue({ status: 'EMPTY' });
    const job = ctx.container.jobQueue.enqueue(request, schedule);
    const progress = () => coordinator.backtestProgress(ctx.container.jobQueue.getJob(job.id)!);
    const observed: ExecutionProgress[] = [];
    const listener = () => { const current = progress(); if (current) observed.push(current); };
    ctx.container.jobQueue.events.on('job', listener);
    try {
      coordinator.start();
      await vi.waitFor(() => expect(progress()?.activity).toBe('WAITING_FOR_MEMORY'));
      expect(progress()?.detail).toContain('최소 필요');
      expect(progress()?.detail).toContain('현재 가용 180 MiB');
      expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({ status: 'QUEUED', attempt: 0, leaseFailures: 0 });
      sample.mockReturnValue(localResources(256 * MIB));
      coordinator.wake();
      await vi.waitFor(() => expect(observed).toEqual(expect.arrayContaining([
        expect.objectContaining({ activity: 'ESTIMATING_JOB_MEMORY', total: 32, completed: 32 }),
      ])));
      expect(progress()?.activity).toBe('ASSIGNING_EXECUTOR');
    } finally {
      ctx.container.jobQueue.events.off('job', listener);
      await coordinator.stop();
      vi.restoreAllMocks();
    }
  });

  it('미리보기는 원격이 없어도 운영 서버의 자원 대기를 표시하고 알림이 재배정을 반복하지 않는다', async ({ ctx }) => {
    const coordinator = ctx.container.agentCoordinator;
    vi.spyOn(resources, 'availableServerResources').mockReturnValue(localResources(64 * MIB, 0));
    const ensure = vi.spyOn(coordinator.snapshots, 'ensureLatest');
    ctx.container.database.sqlite.prepare("INSERT INTO backtest_preparation_jobs (id, request_hash, request_json, status, phase, created_at_ms, updated_at_ms) VALUES ('prep-resource', 'resource', '{}', 'QUEUED', 'MARKET_DATA', 1, 1)").run();
    try {
      coordinator.start();
      const progress = () => coordinator.preparationView(ctx.container.backtestPreparationOrchestrator.get('prep-resource')!).progress;
      await vi.waitFor(() => expect(progress()?.activity).toBe('WAITING_FOR_MEMORY'));
      expect(progress()?.detail).toContain('현재 가용 64 MiB');
      expect(progress()?.detail).not.toContain('연결된 원격 agent가 없습니다');
      coordinator.notifyQueuedProgress();
      await new Promise((resolve) => setImmediate(resolve));
      expect(ensure).not.toHaveBeenCalled();
      expect(progress()).toMatchObject({ unit: null, total: null });
    } finally {
      await coordinator.stop();
      vi.restoreAllMocks();
    }
  });

  it('배정 후 첫 계산 보고 전에는 프로세스 시작을 표시하고 실제 입력 보고로 전환한다', async ({ ctx, cookie }) => {
    const job = ctx.container.jobQueue.enqueue(request, schedule);
    const coordinator = ctx.container.agentCoordinator;
    const lease = coordinator.backtests.claim('server-local', readRuntimeVersions().executionVersion);
    if (lease.status !== 'CLAIMED') throw new Error('리스 배정 실패');
    const get = () => ctx.app.inject({ method: 'GET', url: `/api/v1/backtests/${job.id}`, cookies: { session: cookie } });
    expect((await get()).json().job.progress.activity).toBe('STARTING_WORKER');
    coordinator.backtests.heartbeat({ jobId: job.id, attempt: lease.lease.attempt, leaseToken: lease.lease.leaseToken });
    expect((await get()).json().job.progress.activity).toBe('STARTING_WORKER');
    coordinator.backtests.heartbeat({ jobId: job.id, attempt: lease.lease.attempt, leaseToken: lease.lease.leaseToken,
      activity: 'LOADING_BACKTEST_INPUT', processedBars: 0, totalBars: 0, progressLabel: '입력을 목표 8,192봉씩 나누어 읽습니다 · 작업 메모리 예산 256 MiB' });
    expect((await get()).json().job.progress).toMatchObject({ activity: 'LOADING_BACKTEST_INPUT', total: null,
      detail: '입력을 목표 8,192봉씩 나누어 읽습니다 · 작업 메모리 예산 256 MiB' });
  });
});
