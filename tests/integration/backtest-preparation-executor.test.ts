import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import { createContainer } from '../../src/server/bootstrap/container.js';
import { buildServer } from '../../src/server/bootstrap/server.js';
import { ForkedBacktestPreparationExecutor } from '../../src/server/modules/backtest/infrastructure/forked-backtest-preparation-executor.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { createTestAdmin } from '../helpers/test-app.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars } from '../helpers/seed.js';
import type { PreparationInput } from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';
import type {
  BacktestPreparationExecutionLane,
  PreparationNotification,
  ReadyPreviewDetails,
} from '../../src/server/modules/backtest/application/backtest-preparation-execution.js';
import type { BacktestUniversePreview } from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';
import { backtestPreparationRequestHash } from '../../src/server/modules/backtest/application/backtest-preparation-plan.js';
import { backtestPreparationJobs } from '../../src/server/shared/db/schema.js';

const dirs: string[] = [];
const input: PreparationInput = {
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
    rebalanceInterval: { unit: 'DAY', value: 1 },
  },
  period: { from: '2026-01-05', to: '2026-01-05' },
  strategyId: 'range-breakout',
  parameters: {},
};

function testConfig(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-prep-child-'));
  dirs.push(dir);
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: path.join(dir, 'app.sqlite'),
    DATA_ROOT: path.join(dir, 'market-data'),
    IMPORT_ROOT: path.join(dir, 'imports'),
    EXPORT_ROOT: path.join(dir, 'exports'),
    TEMP_ROOT: path.join(dir, 'temp'),
    SESSION_SECRET: 's'.repeat(48),
    LOG_LEVEL: 'fatal',
    ...env,
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ForkedBacktestPreparationExecutor', () => {
  const fixtureUrl = new URL('../fixtures/preparation-executor-child.ts', import.meta.url);

  it('동기 루프에 막힌 자식도 취소 deadline 뒤 exit를 확인하고 promise를 닫는다', async () => {
    const config = testConfig();
    const executor = new ForkedBacktestPreparationExecutor(config, createLogger(config), {
      childUrl: fixtureUrl,
    });
    let updated = false;
    executor.onJobUpdated(() => { throw new Error('listener test'); });
    executor.onJobUpdated(() => { updated = true; });
    const running = executor.runClaimedJob('block');
    await waitFor(() => updated);
    const startedAt = Date.now();
    expect(executor.cancel('block')).toBe(true);
    expect(executor.cancel('block')).toBe(true);
    await expect(running).rejects.toThrow(/결과 없이 종료|취소/);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_300);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await executor.stop();
  });

  it('RSS 감시 위반은 clean result보다 우선한 명시적 실패가 된다', async () => {
    const config = testConfig();
    const executor = new ForkedBacktestPreparationExecutor(config, createLogger(config), {
      childUrl: fixtureUrl,
      readRssMb: () => config.preparationChildMaxRssMb + 1,
    });
    const running = executor.runClaimedJob('block');
    await expect(running).rejects.toThrow(/RSS.*상한/);
    await executor.stop();
  });

  it('spawn 실패가 lane을 영구 대기 상태로 남기지 않는다', async () => {
    const config = testConfig();
    const executor = new ForkedBacktestPreparationExecutor(config, createLogger(config), {
      childUrl: new URL('file:///definitely-missing/preparation-child.js'),
    });
    await expect(executor.runClaimedJob('missing-1')).rejects.toThrow();
    await expect(executor.runClaimedJob('missing-2')).rejects.toThrow();
    await executor.stop();
  });

  it('notification relay listener 예외가 child 결과 settlement를 막지 않는다', async () => {
    const config = testConfig();
    const executor = new ForkedBacktestPreparationExecutor(config, createLogger(config), {
      childUrl: fixtureUrl,
      onNotificationCreated: () => { throw new Error('SSE listener test'); },
    });
    await expect(executor.runClaimedJob('notify')).resolves.toBeUndefined();
    await executor.stop();
  });

  it('같은 입력의 concurrent 판정은 실제 child 하나로 singleflight한다', async () => {
    const config = testConfig();
    const executor = new ForkedBacktestPreparationExecutor(config, createLogger(config), {
      childUrl: fixtureUrl,
    });
    await Promise.all([executor.needsDart(input), executor.needsDart({ ...input })]);
    const spawns = fs.readFileSync(path.join(config.tempRoot, 'preparation-child-spawns'), 'utf8')
      .trim().split('\n');
    expect(spawns).toHaveLength(1);
    await executor.stop();
  });

  it('다른 작업 뒤에 queued된 RUN_JOB은 취소하면 child를 시작하지 않는다', async () => {
    const config = testConfig({ PREPARATION_EXECUTION_MAX_QUEUED: '7' });
    const executor = new ForkedBacktestPreparationExecutor(config, createLogger(config), {
      childUrl: fixtureUrl,
    });
    const active = executor.needsDart(input);
    await waitFor(() => fs.existsSync(path.join(config.tempRoot, 'preparation-child-started')));
    const queued = executor.runClaimedJob('never-spawn');
    expect(executor.cancel('never-spawn')).toBe(true);
    await expect(queued).rejects.toThrow(/취소/);
    const stopping = executor.stop();
    await expect(active).rejects.toThrow();
    await stopping;
    const spawns = fs.readFileSync(path.join(config.tempRoot, 'preparation-child-spawns'), 'utf8')
      .trim().split('\n');
    expect(spawns).toHaveLength(1);
  });
});

describe('production preparation factory HTTP path', () => {
  it('강제 forked container의 preview 요청이 실제 자식 판정을 거쳐 즉시 202를 반환한다', async () => {
    const config = testConfig();
    const relayedNotifications: PreparationNotification[] = [];
    const container = createContainer(config, {
      preparationExecution: 'forked',
      preparationExecutorOptions: {
        onNotificationCreated: (notification) => relayedNotifications.push(notification),
      },
    });
    const app = await buildServer(container);
    await app.ready();
    try {
      const credentials = await createTestAdmin(container);
      seedSymbolMasterUniverse(container, ['2026-01-05'], [{
        standardCode: 'KR7005930003',
        shortCode: '005930',
        name: '삼성전자',
        market: 'KOSPI',
        marketCapKrw: '500000000000000',
      }]);
      registerSymbols(container, 'KR', ['005930']);
      seedDailyBars(container.database.db, [{
        symbol: '005930',
        market: 'KR',
        timeframe: '1d',
        tsMs: Date.parse('2026-01-05T00:00:00Z'),
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 1_000,
      }]);
      await seedCorporateActionCoverage(container, ['005930'], [2024, 2025, 2026]);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: credentials });
      const cookie = login.cookies.find((item) => item.name === 'qp_session')!.value;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/backtests/universe-preview',
        cookies: { qp_session: cookie },
        payload: {
          universeRule: {
            markets: ['KOSPI'],
            stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
            rebalanceInterval: { unit: 'DAY', value: 1 },
          },
          period: { from: '2026-01-05', to: '2026-01-05' },
          strategyId: 'range-breakout',
          parameters: {},
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ job: { status: 'QUEUED' } });
      const id = response.json<{ job: { id: string } }>().job.id;
      await waitFor(
        () => container.backtestPreparationOrchestrator.get(id)?.status === 'COMPLETED',
        20_000,
      );
      await waitFor(() => (
        container.notificationService.list().length === 1 && relayedNotifications.length === 1
      ));
      const completed = await app.inject({
        method: 'GET',
        url: `/api/v1/backtests/preparation-jobs/${id}`,
        cookies: { qp_session: cookie },
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({
        job: { id, status: 'COMPLETED', overallProgress: 100 },
      });
      expect(container.notificationService.list()).toEqual([
        expect.objectContaining({
          type: 'backtest',
          severity: 'info',
          title: '유니버스 미리보기가 완료되었습니다',
          link: '/backtests/new',
        }),
      ]);
      expect(relayedNotifications).toEqual([
        expect.objectContaining({
          title: '유니버스 미리보기가 완료되었습니다',
        }),
      ]);
      // The actual child writes a receipt that the HTTP parent can immediately reuse.
      container.backtestPreparationOrchestrator.getReadyPreviewDetails = () => {
        throw new Error('HTTP must not revalidate the completed result');
      };
      const replay = await app.inject({
        method: 'POST', url: '/api/v1/backtests/universe-preview',
        cookies: { qp_session: cookie }, payload: input,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ unionSymbols: ['005930'], fundamentalSymbols: [] });
      expect(container.notificationService.list()).toHaveLength(1);
      expect(relayedNotifications).toHaveLength(1);
      expect((await container.backtestPreparationOrchestrator.getReadyPreview(input))?.unionSymbols)
        .toEqual(['005930']);
      expect(container.notificationService.list()).toHaveLength(1);
      expect(relayedNotifications).toHaveLength(1);
      container.database.sqlite.exec("UPDATE krx_daily_bars SET close = close + 1");
      expect(await container.backtestPreparationOrchestrator.getReadyPreview(input)).toBeNull();
    } finally {
      await app.close();
      await container.close();
    }
  }, 45_000);

  it('자식 spawn 실패를 FAILED로 기록하고 실패 알림을 한 건 만든다', async () => {
    const config = testConfig();
    const container = createContainer(config, {
      preparationExecution: 'forked',
      preparationExecutorOptions: {
        childUrl: new URL('file:///definitely-missing/preparation-child.js'),
      },
    });
    try {
      const job = container.backtestPreparationOrchestrator.start(input);
      await waitFor(
        () => container.backtestPreparationOrchestrator.get(job.id)?.status === 'FAILED',
        20_000,
      );
      await waitFor(() => container.notificationService.list().length === 1);

      expect(container.notificationService.list()).toEqual([
        expect.objectContaining({
          type: 'backtest',
          severity: 'error',
          title: '유니버스 미리보기가 실패했습니다',
          link: '/backtests/new',
        }),
      ]);
    } finally {
      await container.close();
    }
  }, 30_000);

  it('in-flight HTTP child가 막혀도 shutdown 순서가 bounded하게 drain을 끝낸다', async () => {
    const config = testConfig({ PREPARATION_EXECUTION_MAX_QUEUED: '7' });
    const container = createContainer(config, {
      preparationExecution: 'forked',
      preparationExecutorOptions: {
        childUrl: new URL('../fixtures/preparation-executor-child.ts', import.meta.url),
      },
    });
    const app = await buildServer(container);
    await app.ready();
    const credentials = await createTestAdmin(container);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: credentials });
    const cookie = login.cookies.find((item) => item.name === 'qp_session')!.value;
    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/v1/backtests/universe-preview',
      cookies: { qp_session: cookie },
      payload: {
        universeRule: {
          markets: ['KOSPI'],
          stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
          rebalanceInterval: { unit: 'DAY', value: 1 },
        },
        period: { from: '2026-01-05', to: '2026-01-05' },
        strategyId: 'range-breakout',
        parameters: {},
      },
    });
    await waitFor(() => fs.existsSync(path.join(config.tempRoot, 'preparation-child-started')));
    const startedAt = Date.now();
    const appClosing = app.close();
    await container.backtestPreparationOrchestrator.stop();
    await appClosing;
    await container.close();
    await responsePromise;
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });
});

describe('parent-owned preparation lifecycle', () => {
  it('legacy completed preview revalidation returns a cancellable 202 without waiting for the child', async () => {
    const config = testConfig({ DART_API_KEY: 'test-key' });
    const lane = new FakeExecutionLane();
    let release!: () => void;
    lane.onRun = () => new Promise<void>((resolve) => { release = resolve; });
    lane.onStop = () => release?.();
    const container = createContainer(config, { preparationExecutionLane: lane });
    const app = await buildServer(container);
    await app.ready();
    try {
      const credentials = await createTestAdmin(container);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: credentials });
      const cookie = login.cookies.find((item) => item.name === 'qp_session')!.value;
      container.database.db.insert(backtestPreparationJobs).values({
        id: 'prep_legacy_completed',
        requestHash: backtestPreparationRequestHash(input, container.strategyRegistry.get(input.strategyId)!),
        requestJson: JSON.stringify(input),
        status: 'COMPLETED', phase: 'FINALIZING',
        previewJson: JSON.stringify({ unionSymbols: [] }),
        createdAtMs: 1, updatedAtMs: 1,
      }).run();
      const request = {
        method: 'POST' as const, url: '/api/v1/backtests/universe-preview',
        cookies: { qp_session: cookie }, payload: input,
      };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(202);
      const id = first.json<{ job: { id: string } }>().job.id;
      expect(id).not.toBe('prep_legacy_completed');
      await waitFor(() => lane.startedJobs.includes(id));
      const repeated = await Promise.all([app.inject(request), app.inject(request)]);
      for (const response of repeated) {
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({ job: { id, status: 'RUNNING' } });
      }
      expect(lane.startedJobs).toEqual([id]);
      expect(lane.readyDetailsCalls).toBe(0);
      expect((await app.inject({ method: 'GET', url: '/api/v1/health/ready' })).statusCode).toBe(200);
      const cancelled = await app.inject({
        method: 'POST', url: `/api/v1/backtests/preparation-jobs/${id}/cancel`,
        cookies: { qp_session: cookie },
      });
      expect(cancelled.statusCode).toBe(200);
      release();
      await waitFor(() => container.backtestPreparationOrchestrator.get(id)?.status === 'CANCELLED');
      expect(container.backtestPreparationOrchestrator.get('prep_legacy_completed')?.status).toBe('COMPLETED');
    } finally {
      release?.();
      await app.close();
      await container.close();
    }
  });

  it('동일 입력 active job HTTP는 heavy revalidation을 부르지 않고 같은 202를 반환한다', async () => {
    const config = testConfig();
    const lane = new FakeExecutionLane();
    let release!: () => void;
    lane.onRun = () => new Promise<void>((resolve) => { release = resolve; });
    lane.onStop = () => release?.();
    const container = createContainer(config, { preparationExecutionLane: lane });
    const app = await buildServer(container);
    await app.ready();
    try {
      const credentials = await createTestAdmin(container);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: credentials });
      const cookie = login.cookies.find((item) => item.name === 'qp_session')!.value;
      const job = container.backtestPreparationOrchestrator.start(input);
      await waitFor(() => lane.startedJobs.includes(job.id));
      const startedAt = Date.now();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/backtests/universe-preview',
        cookies: { qp_session: cookie },
        payload: input,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ job: { id: job.id, status: 'RUNNING' } });
      expect(lane.readyDetailsCalls).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(100);
    } finally {
      release?.();
      await app.close();
      await container.close();
    }
  });

  it('child가 WAITING_DAILY_QUOTA로 끝나면 부모 timer가 다시 QUEUED로 올려 실행한다', async () => {
    const config = testConfig();
    const lane = new FakeExecutionLane();
    const container = createContainer(config, { preparationExecutionLane: lane });
    lane.onRun = async (jobId) => {
      lane.runCount += 1;
      if (lane.runCount === 1) {
        container.database.db.update(backtestPreparationJobs).set({
          status: 'WAITING_DAILY_QUOTA',
          nextResumeAtMs: Date.now() + 50,
        }).where(eq(backtestPreparationJobs.id, jobId)).run();
      } else {
        container.database.db.update(backtestPreparationJobs).set({ status: 'COMPLETED' })
          .where(eq(backtestPreparationJobs.id, jobId)).run();
      }
    };
    try {
      const job = container.backtestPreparationOrchestrator.start(input);
      await waitFor(() => container.backtestPreparationOrchestrator.get(job.id)?.status === 'COMPLETED');
      expect(lane.runCount).toBe(2);
    } finally {
      await container.close();
    }
  });

  it('orphan RUNNING 복구는 무거운 실행을 기다리지 않고 동일 요청 active snapshot을 제공한다', async () => {
    const config = testConfig();
    const lane = new FakeExecutionLane();
    const container = createContainer(config, { preparationExecutionLane: lane });
    const strategy = container.strategyRegistry.get(input.strategyId)!;
    const requestHash = backtestPreparationRequestHash(input, strategy);
    container.database.db.insert(backtestPreparationJobs).values({
      id: 'prep_orphan',
      requestHash,
      requestJson: JSON.stringify(input),
      status: 'RUNNING',
      phase: 'RESOLVING_STAGES',
      doneSymbols: 0,
      totalSymbols: 1,
      savedFacts: 0,
      gapCount: 0,
      dartCallsUsed: 0,
      cancelRequested: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    }).run();
    try {
      const startedAt = Date.now();
      container.backtestPreparationOrchestrator.recoverOrphaned();
      expect(container.backtestPreparationOrchestrator.getActive(input)).toMatchObject({
        id: 'prep_orphan',
        status: 'QUEUED',
      });
      expect(Date.now() - startedAt).toBeLessThan(100);
      await waitFor(() => container.backtestPreparationOrchestrator.get('prep_orphan')?.status === 'FAILED');
    } finally {
      await container.close();
    }
  });
});

class FakeExecutionLane implements BacktestPreparationExecutionLane {
  runCount = 0;
  readyDetailsCalls = 0;
  readonly startedJobs: string[] = [];
  onRun: (jobId: string) => Promise<void> = async () => undefined;
  onStop: () => void = () => undefined;
  runClaimedJob(jobId: string): Promise<void> {
    this.startedJobs.push(jobId);
    return this.onRun(jobId);
  }
  getReadyPreview(): Promise<BacktestUniversePreview | null> { return Promise.resolve(null); }
  getReadyPreviewDetails(): Promise<ReadyPreviewDetails | null> {
    this.readyDetailsCalls += 1;
    return Promise.resolve(null);
  }
  getCachedPreview(): Promise<BacktestUniversePreview | null> { return Promise.resolve(null); }
  needsDart(): Promise<boolean> { return Promise.resolve(false); }
  cancel(): boolean { return false; }
  onJobUpdated(): () => void { return () => undefined; }
  stop(): Promise<void> {
    this.onStop();
    return Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
