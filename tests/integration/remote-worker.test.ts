import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createServer,
  get as httpGet,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { backtestJobs, symbols } from '../../src/server/shared/db/schema.js';
import { eq } from 'drizzle-orm';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import type { BacktestResultArtifact } from '../../src/server/modules/backtest/application/backtest-result-artifact.js';
import type { BacktestResultWriteContext } from '../../src/server/modules/backtest/application/backtest-result-artifact.js';
import { SqliteBacktestResultArtifactWriter } from '../../src/server/modules/backtest/infrastructure/sqlite-backtest-result-artifact-writer.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { registerSymbols, seedDailyBars } from '../helpers/seed.js';
import { backtestRequestSchema } from '../../src/shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../../src/shared/schemas/provenance-pin.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import { strategySourceHash } from '../../src/server/modules/strategy/application/strategy-source-hash.js';
import { ENGINE_VERSION } from '../../src/server/modules/backtest/domain/engine.js';
import {
  getCostProfile,
  getSlippageProfile,
} from '../../src/server/modules/backtest/domain/cost-profiles.js';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../src/server/modules/backtest/application/remote-worker-protocol.js';

const WORKER_TOKEN = 'remote-worker-token-for-tests-1234567890';
const DAY_MS = 86_400_000;

async function waitForTerminalJob(
  ctx: TestApp,
  jobId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const job = ctx.container.jobQueue.getJob(jobId);
    if (job !== null && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`remote worker timeout: ${job?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      timer.unref();
    }),
  ]);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function request(): BacktestRequest {
  return {
    strategyId: 'range-breakout',
    parameters: {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      riskPerTradePercent: 2,
    },
    universeRule: {
      markets: ['KOSPI'],
      stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
      rebalanceInterval: { value: 1, unit: 'MONTH' },
    },
    period: { from: '2026-01-05', to: '2026-02-05' },
    capital: { initialCash: 10_000_000, currency: 'KRW' },
    execution: {
      fillTiming: 'NEXT_BAR_OPEN',
      commissionProfileId: 'kr-equity-default',
      slippageProfileId: 'fixed-5bps',
    },
    risk: { maxPositions: 1 },
    randomSeed: 42,
  };
}

describe('remote backtest worker lease API', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp({
      BACKTEST_EXECUTION_MODE: 'remote',
      BACKTEST_WORKER_TOKEN: WORKER_TOKEN,
      REMOTE_BACKTEST_LEASE_SECONDS: '15',
      REMOTE_BACKTEST_MAX_ATTEMPTS: '2',
    });
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function claim(runnerVersion = ctx.container.gitCommitSha) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/internal/workers/jobs/claim?waitSeconds=1',
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: { workerId: 'worker-a', runnerVersion },
    });
  }

  function probe(payload: {
    workerId?: string;
    runnerVersion?: string;
    protocolVersion?: number;
  } = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/internal/workers/probe',
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: {
        workerId: payload.workerId ?? 'worker-a',
        runnerVersion: payload.runnerVersion ?? ctx.container.gitCommitSha,
        protocolVersion: payload.protocolVersion ?? REMOTE_WORKER_PROTOCOL_VERSION,
      },
    });
  }

  function enqueue() {
    ctx.container.database.db.insert(symbols).values({
      code: '005930',
      market: 'KR',
      name: '삼성전자',
      standardCode: 'KR7005930003',
      createdAtMs: Date.now(),
    }).run();
    return ctx.container.jobQueue.enqueue(request(), [{
      rebalanceDate: '2026-01-05',
      effectiveTradingDate: '2026-01-05',
      symbols: ['005930'],
      excludedNonTradingCount: 0,
    }]);
  }

  function resultArtifact(): BacktestResultArtifact {
    return {
      schemaVersion: 1,
      metrics: {
        initialCash: 10_000_000,
        finalEquity: 11_000_000,
        totalReturnPct: 10,
        cagrPct: 10,
        maxDrawdownPct: -5,
        maxDrawdownDurationMs: 0,
        volatilityPct: 2,
        sharpe: 1,
        sortino: 1,
        calmar: 2,
        winRate: 100,
        profitFactor: null,
        avgWin: 100,
        avgLoss: null,
        maxConsecutiveWins: 1,
        maxConsecutiveLosses: 0,
        tradeCount: 1,
        avgHoldingTimeMs: 1,
        maxConcurrentPositions: 1,
        totalCommission: 1,
        totalTax: 2,
        totalSlippage: 3,
      },
      openPositions: [],
      equityPoints: [{ tsMs: 1, equity: 1_100 }],
      drawdownPoints: [{ tsMs: 1, drawdown: -0.05 }],
      trades: [{
        symbol: '005930',
        quantity: 1,
        entryTsMs: 1,
        exitTsMs: 2,
        entryPrice: 100,
        exitPrice: 110,
        grossPnl: 10,
        costs: 1,
        netPnl: 9,
        returnPct: 9,
        holdingTimeMs: 1,
        exitReason: 'TEST',
      }],
      monthlyReturns: [{ year: 2026, month: 1, returnPct: 10 }],
      warnings: [],
      processedBars: 10,
    };
  }

  function resultContext(job: ReturnType<typeof enqueue>): BacktestResultWriteContext {
    const parsedRequest = backtestRequestSchema.parse(JSON.parse(job.requestJson));
    const registry = new StrategyRegistry();
    const strategy = registry.get(parsedRequest.strategyId);
    const parameters = registry.validateParameters(parsedRequest.strategyId, parsedRequest.parameters);
    const costProfile = getCostProfile(parsedRequest.execution.commissionProfileId);
    const slippageProfile = getSlippageProfile(parsedRequest.execution.slippageProfileId);
    if (strategy === null || !parameters.ok || costProfile === null || slippageProfile === null) {
      throw new Error('test request registry mismatch');
    }
    const pin = job.provenancePinJson === null
      ? null
      : JSON.parse(job.provenancePinJson) as ProvenancePin;
    return {
      jobId: job.id,
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      strategySourceHash: strategySourceHash(strategy),
      parameterJson: JSON.stringify(parameters.value),
      universeRuleJson: job.universeRuleJson,
      scheduleHash: pin?.scheduleHash ?? 'unknown',
      universeJson: job.universeJson ?? '[]',
      universeHash: job.universeHash ?? 'unknown',
      engineVersion: ENGINE_VERSION,
      feeModelVersion: `${costProfile.id}@${costProfile.version}`,
      slippageModelVersion: `${slippageProfile.id}@${slippageProfile.version}`,
      randomSeed: parsedRequest.randomSeed,
      gitCommitSha: ctx.container.gitCommitSha,
      provenancePinJson: job.provenancePinJson,
      startedAtMs: Date.now() - 100,
      completedAtMs: Date.now(),
    };
  }

  function writeResultArtifact(
    job: ReturnType<typeof enqueue>,
    artifactPath: string,
    contextPatch: Partial<BacktestResultWriteContext> = {},
  ): void {
    new SqliteBacktestResultArtifactWriter(artifactPath).write({
      ...resultContext(job),
      ...contextPatch,
    }, resultArtifact());
  }

  it('authenticates, versions, leases, renews, and cancels without storing lease plaintext', async () => {
    const job = enqueue();

    const unauthenticated = await ctx.app.inject({
      method: 'POST',
      url: '/api/internal/workers/jobs/claim?waitSeconds=1',
      payload: { workerId: 'worker-a', runnerVersion: ctx.container.gitCommitSha },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const mismatch = await claim('different-release');
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({
      error: 'RUNNER_VERSION_MISMATCH',
      expectedRunnerVersion: ctx.container.gitCommitSha,
    });
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('QUEUED');

    const claimed = await claim();
    expect(claimed.statusCode).toBe(200);
    const lease = claimed.json() as {
      jobId: string;
      attempt: number;
      leaseToken: string;
      leaseExpiresAtMs: number;
      heartbeatIntervalMs: number;
      runnerVersion: string;
    };
    expect(lease).toMatchObject({
      jobId: job.id,
      attempt: 1,
      runnerVersion: ctx.container.gitCommitSha,
    });
    expect(lease.heartbeatIntervalMs).toBeGreaterThanOrEqual(4_000);
    expect(lease.heartbeatIntervalMs).toBeLessThanOrEqual(5_000);
    const stored = ctx.container.jobQueue.getJob(job.id)!;
    expect(stored.status).toBe('STARTING');
    expect(stored.workerId).toBe('remote:worker-a');
    expect(stored.leaseTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.leaseTokenHash).not.toContain(lease.leaseToken);

    const input = await ctx.app.inject({
      method: 'GET',
      url: `/api/internal/workers/jobs/${job.id}/input?attempt=${lease.attempt}`,
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-lease-token': lease.leaseToken,
      },
    });
    expect(input.statusCode).toBe(200);
    expect(input.headers['content-type']).toContain('application/vnd.quant-platform.backtest-input+sqlite');
    expect(input.headers['x-content-sha256']).toMatch(/^[a-f0-9]{64}$/);
    const downloadedPath = path.join(ctx.dir, 'downloaded-input.sqlite');
    fs.writeFileSync(downloadedPath, input.rawPayload);
    const downloaded = new Database(downloadedPath, { readonly: true });
    expect((downloaded.prepare('SELECT count(*) AS count FROM backtest_jobs').get() as { count: number }).count).toBe(1);
    expect((downloaded.prepare('SELECT count(*) AS count FROM symbols').get() as { count: number }).count).toBe(1);
    expect((downloaded.prepare('SELECT count(*) AS count FROM audit_logs').get() as { count: number }).count).toBe(0);
    expect((downloaded.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count).toBe(0);
    expect(downloaded.prepare(
      'SELECT lease_token_hash AS leaseTokenHash FROM backtest_jobs WHERE id = ?',
    ).get(job.id)).toEqual({ leaseTokenHash: null });
    downloaded.close();

    const wrongHeartbeat = await ctx.app.inject({
      method: 'POST',
      url: `/api/internal/workers/jobs/${job.id}/heartbeat`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: { attempt: 1, leaseToken: 'x'.repeat(43), processedBars: 10, totalBars: 100 },
    });
    expect(wrongHeartbeat.statusCode).toBe(409);

    const inconsistentProgress = await ctx.app.inject({
      method: 'POST',
      url: `/api/internal/workers/jobs/${job.id}/heartbeat`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: {
        attempt: lease.attempt,
        leaseToken: lease.leaseToken,
        processedBars: 101,
        totalBars: 100,
      },
    });
    expect(inconsistentProgress.statusCode).toBe(400);

    const heartbeat = await ctx.app.inject({
      method: 'POST',
      url: `/api/internal/workers/jobs/${job.id}/heartbeat`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: {
        attempt: lease.attempt,
        leaseToken: lease.leaseToken,
        processedBars: 10,
        totalBars: 100,
        progressLabel: '2026-01-15',
      },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({ status: 'ACCEPTED', cancelRequested: false });
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({
      status: 'RUNNING',
      progressBars: 10,
      totalBars: 100,
      progressLabel: '2026-01-15',
    });

    expect(ctx.container.jobOrchestrator.cancel(job.id)).toBe('CANCELLING');
    const cancellingHeartbeat = await ctx.app.inject({
      method: 'POST',
      url: `/api/internal/workers/jobs/${job.id}/heartbeat`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: { attempt: lease.attempt, leaseToken: lease.leaseToken },
    });
    expect(cancellingHeartbeat.json()).toMatchObject({ cancelRequested: true });

    const finished = await ctx.app.inject({
      method: 'POST',
      url: `/api/internal/workers/jobs/${job.id}/finish`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: { attempt: lease.attempt, leaseToken: lease.leaseToken, outcome: 'CANCELLED' },
    });
    expect(finished.statusCode).toBe(200);
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({
      status: 'CANCELLED',
      leaseTokenHash: null,
      leaseExpiresAtMs: null,
    });

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/internal/workers/jobs/${job.id}/finish`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: { attempt: lease.attempt, leaseToken: lease.leaseToken, outcome: 'CANCELLED' },
    });
    expect(replay.statusCode).toBe(409);
  });

  it('probes authentication, runner release, and protocol without claiming a job', async () => {
    const unauthenticated = await ctx.app.inject({
      method: 'POST',
      url: '/api/internal/workers/probe',
      payload: {
        workerId: 'worker-a',
        runnerVersion: ctx.container.gitCommitSha,
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const releaseMismatch = await probe({ runnerVersion: 'different-release' });
    expect(releaseMismatch.statusCode).toBe(409);
    expect(releaseMismatch.json()).toMatchObject({
      error: 'RUNNER_VERSION_MISMATCH',
      expectedRunnerVersion: ctx.container.gitCommitSha,
    });

    const protocolMismatch = await probe({
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION + 1,
    });
    expect(protocolMismatch.statusCode).toBe(409);
    expect(protocolMismatch.json()).toEqual({
      error: 'PROTOCOL_VERSION_MISMATCH',
      expectedProtocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    });

    const ready = await probe();
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'READY',
      runnerVersion: ctx.container.gitCommitSha,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    });
    expect(ctx.container.jobQueue.countByStatus(['STARTING', 'RUNNING'])).toBe(0);
  });

  it('holds an empty claim until its long-poll deadline', async () => {
    const appUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const startedAtMs = Date.now();
    const response = await fetch(`${appUrl}/api/internal/workers/jobs/claim?waitSeconds=1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workerId: 'long-poll-worker',
        runnerVersion: ctx.container.gitCommitSha,
      }),
    });
    const elapsedMs = Date.now() - startedAtMs;

    expect(response.status).toBe(204);
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it('stops checking the queue after a long-poll client disconnects', async () => {
    const appUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const service = ctx.container.remoteWorkerService;
    const originalClaim = service.claim.bind(service);
    let claimCalls = 0;
    service.claim = (...args: Parameters<typeof service.claim>) => {
      claimCalls += 1;
      return originalClaim(...args);
    };
    const request = httpRequest(`${appUrl}/api/internal/workers/jobs/claim?waitSeconds=5`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'content-type': 'application/json',
      },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify({
      workerId: 'disconnecting-worker',
      runnerVersion: ctx.container.gitCommitSha,
    }));

    try {
      await withTimeout((async () => {
        while (claimCalls === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      })(), 1_000, 'long-poll did not start');
      const callsBeforeDisconnect = claimCalls;
      request.destroy();
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(claimCalls).toBe(callsBeforeDisconnect);
      const callsAfterDisconnect = claimCalls;
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(claimCalls).toBe(callsAfterDisconnect);
    } finally {
      request.destroy();
      service.claim = originalClaim;
    }
  });

  it('rejects zero-wait claims that could create tight polling', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/internal/workers/jobs/claim?waitSeconds=0',
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: { workerId: 'worker-a', runnerVersion: ctx.container.gitCommitSha },
    });

    expect(response.statusCode).toBe(400);
  });

  it('paces empty claims when a server returns 204 before the requested deadline', async () => {
    const claimTimes: number[] = [];
    const earlyResponseServer = createServer((request, response) => {
      request.resume();
      claimTimes.push(Date.now());
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve, reject) => {
      earlyResponseServer.once('error', reject);
      earlyResponseServer.listen(0, '127.0.0.1', resolve);
    });
    const address = earlyResponseServer.address();
    if (address === null || typeof address === 'string') throw new Error('test server address unavailable');
    const supervisor = spawn(
      process.execPath,
      ['--import', 'tsx', path.resolve('src/workers/remote-backtest-supervisor.ts')],
      {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          BACKTEST_APP_URL: `http://127.0.0.1:${address.port}`,
          BACKTEST_WORKER_TOKEN: WORKER_TOKEN,
          BACKTEST_WORKER_ID: 'paced-worker',
          BACKTEST_WORKER_CONCURRENCY: '1',
          BACKTEST_WORK_ROOT: path.join(ctx.dir, 'paced-worker'),
          BACKTEST_CLAIM_WAIT_SECONDS: '1',
          LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    supervisor.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    try {
      await withTimeout((async () => {
        while (claimTimes.length < 3) await new Promise((resolve) => setTimeout(resolve, 25));
      })(), 5_000, `paced claim timeout: ${stderr}`);
      expect(claimTimes[1]! - claimTimes[0]!).toBeGreaterThanOrEqual(900);
      expect(claimTimes[2]! - claimTimes[1]!).toBeGreaterThanOrEqual(900);
    } finally {
      await stopProcess(supervisor);
      await new Promise<void>((resolve, reject) => {
        earlyResponseServer.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });

  it('runs the supervisor one-shot compatibility check without claiming a job', async () => {
    const appUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const checked = spawn(process.execPath, [
      '--import',
      'tsx',
      path.resolve('src/workers/remote-backtest-supervisor.ts'),
      '--check',
    ], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        BUILD_GIT_SHA: ctx.container.gitCommitSha,
        BACKTEST_APP_URL: appUrl,
        BACKTEST_WORKER_TOKEN: WORKER_TOKEN,
        BACKTEST_WORKER_ID: 'check-worker',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    checked.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    checked.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      checked.once('error', reject);
      checked.once('exit', (code) => resolve(code));
    });
    expect(exit, stderr).toBe(0);
    expect(stdout).toBe('READY\n');
    expect(ctx.container.jobQueue.countByStatus(['STARTING', 'RUNNING'])).toBe(0);
  });

  it('requeues one expired lease and fails after the configured attempt limit', async () => {
    const job = enqueue();
    const first = (await claim()).json() as { attempt: number };
    expect(first.attempt).toBe(1);

    ctx.container.database.db.update(backtestJobs)
      .set({
        leaseExpiresAtMs: Date.now() - 1,
        progressBars: 10,
        totalBars: 100,
        progressLabel: '2026-01-15',
      })
      .where(eq(backtestJobs.id, job.id))
      .run();
    ctx.container.remoteWorkerService.sweepExpiredLeases();
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({
      status: 'QUEUED',
      attempt: 1,
      workerId: null,
    });

    const second = (await claim()).json() as { attempt: number };
    expect(second.attempt).toBe(2);
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({
      status: 'STARTING',
      progressBars: null,
      totalBars: null,
      progressLabel: null,
    });
    ctx.container.database.db.update(backtestJobs)
      .set({ leaseExpiresAtMs: Date.now() - 1 })
      .where(eq(backtestJobs.id, job.id))
      .run();
    ctx.container.remoteWorkerService.sweepExpiredLeases();
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({
      status: 'FAILED',
      attempt: 2,
      workerId: 'remote:worker-a',
    });
  });

  it('keeps a user cancellation terminal when a worker races with a failed finish', async () => {
    const job = enqueue();
    const lease = (await claim()).json() as { attempt: number; leaseToken: string };
    expect(ctx.container.jobOrchestrator.cancel(job.id)).toBe('CANCELLING');

    const finished = await ctx.app.inject({
      method: 'POST',
      url: `/api/internal/workers/jobs/${job.id}/finish`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: {
        attempt: lease.attempt,
        leaseToken: lease.leaseToken,
        outcome: 'FAILED',
        error: 'child exited during cancellation',
        telemetry: {
          schemaVersion: 1,
          outcome: 'FAILED',
          failedStage: 'RUN',
          durationsMs: { load: 1, run: 1, persist: 0, total: 2 },
          peakRssBytes: 1,
          input: null,
          output: null,
        },
      },
    });

    expect(finished.statusCode).toBe(200);
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({
      status: 'CANCELLED',
      error: null,
    });
    const audit = ctx.container.database.sqlite.prepare(
      "SELECT detail_json AS detailJson FROM audit_logs WHERE event = 'backtest.finished' ORDER BY id DESC LIMIT 1",
    ).get() as { detailJson: string };
    expect(JSON.parse(audit.detailJson)).toMatchObject({
      jobId: job.id,
      status: 'CANCELLED',
    });
    expect(JSON.parse(audit.detailJson)).not.toHaveProperty('executionTelemetry');
  });

  it('fails a queued retry that became exhausted after lowering max attempts', async () => {
    const job = enqueue();
    await claim();
    ctx.container.database.db.update(backtestJobs)
      .set({ leaseExpiresAtMs: Date.now() - 1 })
      .where(eq(backtestJobs.id, job.id))
      .run();
    ctx.container.remoteWorkerService.sweepExpiredLeases();
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('QUEUED');

    const recovered = ctx.container.jobQueue.recoverExpiredRemoteLeases(1);

    expect(recovered).toEqual([{ jobId: job.id, status: 'FAILED', attempt: 1 }]);
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({
      status: 'FAILED',
      attempt: 1,
      completedAtMs: expect.any(Number),
    });
  });

  it('streams, validates, atomically imports, and idempotently accepts a result artifact', async () => {
    const job = enqueue();
    const lease = (await claim()).json() as {
      attempt: number;
      leaseToken: string;
    };
    const artifactPath = path.join(ctx.dir, 'result.sqlite');
    writeResultArtifact(job, artifactPath);
    const payload = fs.readFileSync(artifactPath);
    const checksum = createHash('sha256').update(payload).digest('hex');
    const upload = () => ctx.app.inject({
      method: 'PUT',
      url: `/api/internal/workers/jobs/${job.id}/result?attempt=${lease.attempt}`,
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
        'x-lease-token': lease.leaseToken,
        'x-content-sha256': checksum,
      },
      payload,
    });

    const completed = await upload();
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({ status: 'ACCEPTED' });
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({
      status: 'COMPLETED',
      resultSchemaVersion: 1,
      resultChecksum: checksum,
      progressBars: 10,
      totalBars: 10,
    });
    expect(ctx.container.resultsService.getTotalReturnPct(job.id)).toBe(10);

    const replay = await upload();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: 'IDEMPOTENT' });
    expect(ctx.container.database.sqlite.prepare(
      'SELECT count(*) AS count FROM backtest_runs WHERE job_id = ?',
    ).get(job.id)).toEqual({ count: 1 });
  });

  it('streams remote completion to an already connected backtest SSE client', async () => {
    const job = enqueue();
    const lease = (await claim()).json() as { attempt: number; leaseToken: string };
    const artifactPath = path.join(ctx.dir, 'sse-result.sqlite');
    writeResultArtifact(job, artifactPath);
    const payload = fs.readFileSync(artifactPath);
    const checksum = createHash('sha256').update(payload).digest('hex');
    const credentials = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: credentials,
    });
    const cookie = login.cookies.find((item) => item.name === 'qp_session')!.value;
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpGet(`${address}/api/v1/backtests/${job.id}/events`, {
        headers: { cookie: `qp_session=${cookie}` },
      }, resolve);
      request.once('error', reject);
    });
    let resolveInitial!: () => void;
    const initialSnapshot = new Promise<void>((resolve) => { resolveInitial = resolve; });
    let streamBody = '';
    const streamEnded = (async () => {
      for await (const chunk of response) {
        streamBody += String(chunk);
        if (streamBody.includes('"status":"STARTING"')) resolveInitial();
      }
    })();

    try {
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      await withTimeout(initialSnapshot, 2_000, 'SSE initial snapshot timeout');

      const completed = await ctx.app.inject({
        method: 'PUT',
        url: `/api/internal/workers/jobs/${job.id}/result?attempt=${lease.attempt}`,
        headers: {
          authorization: `Bearer ${WORKER_TOKEN}`,
          'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
          'x-lease-token': lease.leaseToken,
          'x-content-sha256': checksum,
        },
        payload,
      });
      expect(completed.statusCode).toBe(200);
      await withTimeout(streamEnded, 5_000, 'remote completion SSE timeout');
      expect(streamBody).toContain('"status":"COMPLETED"');
    } finally {
      response.destroy();
    }
  });

  it('rejects a malformed artifact without partially importing result rows', async () => {
    const job = enqueue();
    const lease = (await claim()).json() as { attempt: number; leaseToken: string };
    const artifactPath = path.join(ctx.dir, 'malformed-result.sqlite');
    writeResultArtifact(job, artifactPath);
    const artifact = new Database(artifactPath);
    artifact.prepare('DELETE FROM trades').run();
    artifact.close();
    const payload = fs.readFileSync(artifactPath);
    const checksum = createHash('sha256').update(payload).digest('hex');

    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/internal/workers/jobs/${job.id}/result?attempt=${lease.attempt}`,
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
        'x-lease-token': lease.leaseToken,
        'x-content-sha256': checksum,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_RESULT_ARTIFACT' });
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('RUNNING');
    expect(ctx.container.resultsService.getTotalReturnPct(job.id)).toBeNull();
    expect(ctx.container.database.sqlite.prepare(
      'SELECT count(*) AS count FROM backtest_runs WHERE job_id = ?',
    ).get(job.id)).toEqual({ count: 0 });
  });

  it('rejects result metadata that does not match the app-owned execution pins', async () => {
    const job = enqueue();
    const lease = (await claim()).json() as { attempt: number; leaseToken: string };
    const artifactPath = path.join(ctx.dir, 'wrong-context-result.sqlite');
    writeResultArtifact(job, artifactPath, { parameterJson: '{}' });
    const payload = fs.readFileSync(artifactPath);
    const checksum = createHash('sha256').update(payload).digest('hex');

    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/internal/workers/jobs/${job.id}/result?attempt=${lease.attempt}`,
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
        'x-lease-token': lease.leaseToken,
        'x-content-sha256': checksum,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('RUNNING');
    expect(ctx.container.database.sqlite.prepare(
      'SELECT count(*) AS count FROM backtest_runs WHERE job_id = ?',
    ).get(job.id)).toEqual({ count: 0 });
  });

  it('rejects extra SQLite schema objects in an uploaded result', async () => {
    const job = enqueue();
    const lease = (await claim()).json() as { attempt: number; leaseToken: string };
    const artifactPath = path.join(ctx.dir, 'extra-schema-result.sqlite');
    writeResultArtifact(job, artifactPath);
    const artifact = new Database(artifactPath);
    artifact.exec('CREATE TABLE unexpected (value TEXT) STRICT');
    artifact.close();
    const payload = fs.readFileSync(artifactPath);
    const checksum = createHash('sha256').update(payload).digest('hex');

    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/internal/workers/jobs/${job.id}/result?attempt=${lease.attempt}`,
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
        'x-lease-token': lease.leaseToken,
        'x-content-sha256': checksum,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('RUNNING');
  });

  it('keeps lease sweep storage contention from escaping the timer boundary', () => {
    const original = ctx.container.jobQueue.recoverExpiredRemoteLeases.bind(ctx.container.jobQueue);
    ctx.container.jobQueue.recoverExpiredRemoteLeases = () => {
      throw new Error('database is locked');
    };
    try {
      expect(() => ctx.container.remoteWorkerService.sweepExpiredLeases()).not.toThrow();
    } finally {
      ctx.container.jobQueue.recoverExpiredRemoteLeases = original;
    }
  });

  it('removes orphaned app input bundles without crossing into upload cleanup', async () => {
    const remoteRoot = path.join(ctx.dir, 'temp', 'remote-backtests');
    const inputFragment = path.join(remoteRoot, 'bt_orphan', '1', 'input.sqlite.partial');
    const uploadFragment = path.join(remoteRoot, 'uploads', 'in-flight', 'result.sqlite');
    fs.mkdirSync(path.dirname(inputFragment), { recursive: true });
    fs.mkdirSync(path.dirname(uploadFragment), { recursive: true });
    fs.writeFileSync(inputFragment, 'input');
    fs.writeFileSync(uploadFragment, 'result');

    await ctx.container.remoteInputBundleManager.cleanupOrphanedBundles();

    expect(fs.existsSync(path.join(remoteRoot, 'bt_orphan'))).toBe(false);
    expect(fs.existsSync(uploadFragment)).toBe(true);
  });

  it('runs the real remote supervisor and child process end to end', async () => {
    registerSymbols(ctx.container, 'KR', ['005930']);
    const candles: Candle[] = [];
    for (let tsMs = Date.UTC(2026, 0, 5); tsMs <= Date.UTC(2026, 1, 5); tsMs += DAY_MS) {
      const day = new Date(tsMs).getUTCDay();
      if (day === 0 || day === 6) continue;
      const sequence = candles.length;
      candles.push({
        symbol: '005930',
        market: 'KR',
        timeframe: '1d',
        tsMs,
        open: 100 + sequence,
        high: 103 + sequence,
        low: 99 + sequence,
        close: 102 + sequence,
        volume: 1_000,
      });
    }
    seedDailyBars(ctx.container.database.db, candles);
    const job = ctx.container.jobQueue.enqueue(request(), [{
      rebalanceDate: '2026-01-05',
      effectiveTradingDate: '2026-01-05',
      symbols: ['005930'],
      excludedNonTradingCount: 0,
    }]);
    const appUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const workerRoot = path.join(ctx.dir, 'worker');
    const staleWorkerFragment = path.join(workerRoot, 'jobs', 'bt_stale', '1', 'result.sqlite');
    fs.mkdirSync(path.dirname(staleWorkerFragment), { recursive: true });
    fs.writeFileSync(staleWorkerFragment, 'stale');
    const supervisor = spawn(
      process.execPath,
      ['--import', 'tsx', path.resolve('src/workers/remote-backtest-supervisor.ts')],
      {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          BACKTEST_APP_URL: appUrl,
          BACKTEST_WORKER_TOKEN: WORKER_TOKEN,
          BACKTEST_WORKER_ID: 'integration-worker',
          BACKTEST_WORKER_CONCURRENCY: '1',
          BACKTEST_WORK_ROOT: workerRoot,
          BACKTEST_CLAIM_WAIT_SECONDS: '1',
          BACKTEST_HEARTBEAT_SECONDS: '2',
          LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    supervisor.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    supervisor.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    try {
      await waitForTerminalJob(ctx, job.id);
      const completed = ctx.container.jobQueue.getJob(job.id)!;
      expect(completed, output).toMatchObject({
        status: 'COMPLETED',
        attempt: 1,
        runnerVersion: ctx.container.gitCommitSha,
        resultSchemaVersion: 1,
      });
      expect(ctx.container.resultsService.getTotalReturnPct(job.id)).not.toBeNull();
      expect(fs.existsSync(staleWorkerFragment)).toBe(false);
      const jobDirectory = path.join(ctx.dir, 'worker', 'jobs', job.id, '1');
      const cleanupStartedAt = Date.now();
      while (fs.existsSync(jobDirectory) && Date.now() - cleanupStartedAt < 2_000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.existsSync(jobDirectory)).toBe(false);
    } finally {
      await stopProcess(supervisor);
    }
  }, 40_000);
});

describe('remote backtest worker deployment probe in local mode', () => {
  it('reports standby without exposing the claim API', async () => {
    const local = await createTestApp({
      BACKTEST_EXECUTION_MODE: 'local',
      BACKTEST_WORKER_TOKEN: WORKER_TOKEN,
    });
    try {
      const response = await local.app.inject({
        method: 'POST',
        url: '/api/internal/workers/probe',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: {
          workerId: 'worker-a',
          runnerVersion: local.container.gitCommitSha,
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'STANDBY' });

      const claim = await local.app.inject({
        method: 'POST',
        url: '/api/internal/workers/jobs/claim?waitSeconds=1',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: { workerId: 'worker-a', runnerVersion: local.container.gitCommitSha },
      });
      expect(claim.statusCode).toBe(404);
    } finally {
      await local.close();
    }
  });
});
