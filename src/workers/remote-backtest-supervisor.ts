import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { z } from 'zod';
import { readGitCommitSha } from '../server/shared/build-info.js';
import type { BacktestExecutionTelemetry } from '../server/modules/backtest/application/backtest-execution-telemetry.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  BACKTEST_SERVER_URL: z.string().url(),
  BACKTEST_WORKER_TOKEN: z.string().min(32),
  BACKTEST_WORKER_ID: z.string().regex(/^[a-zA-Z0-9._-]{1,48}$/).optional(),
  BACKTEST_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  BACKTEST_WORK_ROOT: z.string().default('./data/remote-worker'),
  BACKTEST_CLAIM_WAIT_SECONDS: z.coerce.number().int().min(0).max(25).default(25),
  BACKTEST_HEARTBEAT_SECONDS: z.coerce.number().int().min(2).max(20).default(5),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

interface SupervisorConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly serverUrl: URL;
  readonly workerToken: string;
  readonly workerId: string;
  readonly concurrency: number;
  readonly workRoot: string;
  readonly claimWaitSeconds: number;
  readonly heartbeatMs: number;
  readonly logLevel: string;
}

interface ClaimedJob {
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
  readonly heartbeatIntervalMs: number;
  readonly runnerVersion: string;
  readonly inputUrl: string;
}

const claimedJobSchema: z.ZodType<ClaimedJob> = z.object({
  jobId: z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/),
  attempt: z.number().int().positive(),
  leaseToken: z.string().min(32).max(256),
  leaseExpiresAtMs: z.number().int().nonnegative(),
  heartbeatIntervalMs: z.number().int().min(2_000).max(100_000),
  runnerVersion: z.string().min(1).max(128),
  inputUrl: z.string().min(1).max(2_048),
});

type ChildMessage =
  | { readonly type: 'progress'; readonly processedBars: number; readonly totalBars: number; readonly progressLabel: string | null }
  | { readonly type: 'telemetry'; readonly telemetry: BacktestExecutionTelemetry };

function loadSupervisorConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const parsed = envSchema.parse(env);
  const serverUrl = new URL(parsed.BACKTEST_SERVER_URL);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(serverUrl.hostname);
  if (serverUrl.protocol !== 'https:' && !(parsed.NODE_ENV !== 'production' && loopback)) {
    throw new Error('BACKTEST_SERVER_URL은 HTTPS여야 합니다 (개발 loopback만 HTTP 허용)');
  }
  serverUrl.pathname = serverUrl.pathname.replace(/\/$/, '');
  const fallbackId = os.hostname().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48) || 'worker';
  return {
    nodeEnv: parsed.NODE_ENV,
    serverUrl,
    workerToken: parsed.BACKTEST_WORKER_TOKEN,
    workerId: parsed.BACKTEST_WORKER_ID ?? fallbackId,
    concurrency: parsed.BACKTEST_WORKER_CONCURRENCY,
    workRoot: path.resolve(parsed.BACKTEST_WORK_ROOT),
    claimWaitSeconds: parsed.BACKTEST_CLAIM_WAIT_SECONDS,
    heartbeatMs: parsed.BACKTEST_HEARTBEAT_SECONDS * 1_000,
    logLevel: parsed.LOG_LEVEL,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

class RemoteBacktestSupervisor {
  private readonly logger;
  private readonly runnerVersion = readGitCommitSha();
  private stopped = false;
  private readonly activeChildren = new Set<ChildProcess>();
  private readonly requestControllers = new Set<AbortController>();

  constructor(private readonly config: SupervisorConfig) {
    this.logger = pino({
      level: config.logLevel,
      redact: {
        paths: ['workerToken', 'leaseToken', '*.workerToken', '*.leaseToken', 'authorization'],
        censor: '[REDACTED]',
      },
    });
  }

  async run(): Promise<void> {
    if (this.config.nodeEnv === 'production' && this.runnerVersion === 'unknown') {
      throw new Error('remote worker 실행에는 dist/build-info.json의 Git SHA가 필요합니다');
    }
    await fs.mkdir(this.config.workRoot, { recursive: true, mode: 0o700 });
    this.logger.info({
      event: 'remote-worker.started',
      workerId: this.config.workerId,
      concurrency: this.config.concurrency,
      runnerVersion: this.runnerVersion,
    }, 'remote backtest worker started');
    await Promise.all(
      Array.from({ length: this.config.concurrency }, (_, slot) => this.slotLoop(slot + 1)),
    );
  }

  stop(signal: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info({ event: 'remote-worker.stopping', signal }, 'remote worker stopping');
    for (const controller of this.requestControllers) controller.abort();
    for (const child of this.activeChildren) {
      child.send?.({ type: 'cancel' });
      const term = setTimeout(() => child.kill('SIGTERM'), 5_000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      term.unref();
      kill.unref();
    }
  }

  private async slotLoop(slot: number): Promise<void> {
    let retryMs = 1_000;
    while (!this.stopped) {
      try {
        const job = await this.claim(slot);
        retryMs = 1_000;
        if (job === null) continue;
        await this.execute(job, slot);
      } catch (error) {
        if (this.stopped) return;
        this.logger.error({ event: 'remote-worker.slot-error', slot, err: error }, 'worker slot failed');
        await delay(retryMs);
        retryMs = Math.min(30_000, retryMs * 2);
      }
    }
  }

  private async claim(slot: number): Promise<ClaimedJob | null> {
    const response = await this.fetchWithTimeout(
      this.serverEndpoint(`/api/internal/workers/jobs/claim?waitSeconds=${this.config.claimWaitSeconds}`),
      {
        method: 'POST',
        headers: this.jsonHeaders(),
        body: JSON.stringify({
          workerId: `${this.config.workerId}-s${slot}`,
          runnerVersion: this.runnerVersion,
        }),
      },
      (this.config.claimWaitSeconds + 15) * 1_000,
    );
    if (response.status === 204) return null;
    if (response.status === 409) {
      const detail = await response.text();
      throw new Error(`server/worker release 불일치: ${detail.slice(0, 500)}`);
    }
    if (!response.ok) throw new Error(`claim 실패: HTTP ${response.status}`);
    return claimedJobSchema.parse(await response.json());
  }

  private async execute(job: ClaimedJob, slot: number): Promise<void> {
    if (job.runnerVersion !== this.runnerVersion) throw new Error('claim runnerVersion 불일치');
    const directory = path.join(this.config.workRoot, 'jobs', job.jobId, String(job.attempt));
    const inputPath = path.join(directory, 'input.sqlite');
    const resultPath = path.join(directory, 'result.sqlite');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    this.logger.info(
      { event: 'remote-worker.job-started', jobId: job.jobId, attempt: job.attempt, slot },
      'remote job started',
    );

    try {
      await this.downloadInput(job, inputPath);
      const execution = await this.runChild(job, inputPath, resultPath);
      // Worker service 재시작은 사용자 취소가 아니다. 서버에 CANCELLED를 확정하지 않고
      // lease 만료 후 다른 slot/worker가 같은 job을 재시도하게 둔다.
      if (this.stopped) return;
      if (execution.staleLease) return;
      if (execution.telemetry?.outcome === 'CANCELLED' || execution.cancelRequested) {
        await this.finish(job, 'CANCELLED', undefined, execution.telemetry);
        return;
      }
      if (execution.code !== 0 || execution.telemetry?.outcome !== 'COMPLETED') {
        await this.finish(
          job,
          'FAILED',
          execution.stderr || `child 비정상 종료 (code=${execution.code}, signal=${execution.signal ?? 'none'})`,
          execution.telemetry,
        );
        return;
      }
      await this.uploadResult(job, resultPath, execution.telemetry);
      this.logger.info(
        { event: 'remote-worker.job-completed', jobId: job.jobId, attempt: job.attempt, slot },
        'remote job completed',
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  private async downloadInput(job: ClaimedJob, destinationPath: string): Promise<void> {
    const inputUrl = new URL(job.inputUrl, this.config.serverUrl);
    if (inputUrl.origin !== this.config.serverUrl.origin) {
      throw new Error('서버가 다른 origin의 input URL을 반환했습니다');
    }
    const expectedHash = await this.withRequestTimeout(10 * 60_000, async (signal) => {
      const response = await fetch(inputUrl, {
        headers: {
          authorization: `Bearer ${this.config.workerToken}`,
          'x-lease-token': job.leaseToken,
        },
        signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`입력 snapshot 다운로드 실패: HTTP ${response.status}`);
      }
      const checksum = response.headers.get('x-content-sha256');
      if (checksum === null || !/^[a-f0-9]{64}$/.test(checksum)) {
        throw new Error('입력 snapshot checksum 헤더가 없습니다');
      }
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      return checksum;
    });
    const actualHash = await sha256File(destinationPath);
    if (actualHash !== expectedHash) throw new Error('입력 snapshot checksum 불일치');
  }

  private async runChild(job: ClaimedJob, inputPath: string, resultPath: string): Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
    readonly telemetry?: BacktestExecutionTelemetry;
    readonly cancelRequested: boolean;
    readonly staleLease: boolean;
  }> {
    const isTsRuntime = import.meta.url.endsWith('.ts');
    const childUrl = new URL(`./backtest-child.${isTsRuntime ? 'ts' : 'js'}`, import.meta.url);
    const child = fork(fileURLToPath(childUrl), [job.jobId], {
      env: {
        NODE_ENV: this.config.nodeEnv,
        DATABASE_PATH: inputPath,
        BACKTEST_JOB_ID: job.jobId,
        BACKTEST_RESULT_PATH: resultPath,
      },
      execArgv: isTsRuntime ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.activeChildren.add(child);
    let stderr = '';
    let telemetry: BacktestExecutionTelemetry | undefined;
    let progress: { processedBars: number; totalBars: number; progressLabel: string | null } | undefined;
    let cancelRequested = false;
    let staleLease = false;
    let heartbeatInFlight: Promise<void> | null = null;
    let cancelTimers: NodeJS.Timeout[] = [];

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    child.on('message', (message: ChildMessage) => {
      if (message.type === 'telemetry') telemetry = message.telemetry;
      else progress = message;
    });

    const requestCancel = (): void => {
      if (cancelRequested) return;
      cancelRequested = true;
      child.send?.({ type: 'cancel' });
      const term = setTimeout(() => child.kill('SIGTERM'), 5_000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      term.unref();
      kill.unref();
      cancelTimers = [term, kill];
    };
    const heartbeat = async (): Promise<void> => {
      const response = await this.fetchWithTimeout(
        this.serverEndpoint(`/api/internal/workers/jobs/${job.jobId}/heartbeat`), {
        method: 'POST',
        headers: this.jsonHeaders(),
        body: JSON.stringify({
          attempt: job.attempt,
          leaseToken: job.leaseToken,
          ...progress,
        }),
      }, Math.min(10_000, heartbeatMs));
      if (response.status === 409) {
        staleLease = true;
        requestCancel();
        return;
      }
      if (!response.ok) throw new Error(`heartbeat 실패: HTTP ${response.status}`);
      const body = await response.json() as { cancelRequested: boolean };
      if (body.cancelRequested) requestCancel();
    };
    const heartbeatMs = Math.min(this.config.heartbeatMs, job.heartbeatIntervalMs);
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight !== null) return;
      heartbeatInFlight = heartbeat()
        .catch((error) => this.logger.warn(
          { event: 'remote-worker.heartbeat-failed', jobId: job.jobId, err: error },
          'heartbeat failed',
        ))
        .finally(() => { heartbeatInFlight = null; });
    }, heartbeatMs);
    heartbeatTimer.unref();
    try {
      await heartbeat();
      const exit = await exitPromise;
      return {
        ...exit,
        stderr: stderr.trim().slice(0, 2_000),
        ...(telemetry === undefined ? {} : { telemetry }),
        cancelRequested,
        staleLease,
      };
    } catch (error) {
      // 초기 heartbeat나 spawn 자체가 실패해도 계산 child를 고아 프로세스로 남기지 않는다.
      requestCancel();
      await exitPromise.catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
      for (const timer of cancelTimers) clearTimeout(timer);
      if (heartbeatInFlight !== null) await heartbeatInFlight;
      this.activeChildren.delete(child);
    }
  }

  private async uploadResult(
    job: ClaimedJob,
    resultPath: string,
    telemetry: BacktestExecutionTelemetry,
  ): Promise<void> {
    const checksum = await sha256File(resultPath);
    const stat = await fs.stat(resultPath);
    const response = await this.fetchWithTimeout(
      this.serverEndpoint(`/api/internal/workers/jobs/${job.jobId}/result?attempt=${job.attempt}`),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.config.workerToken}`,
          'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
          'content-length': String(stat.size),
          'x-lease-token': job.leaseToken,
          'x-content-sha256': checksum,
          'x-execution-telemetry': Buffer.from(JSON.stringify(telemetry)).toString('base64url'),
        },
        body: createReadStream(resultPath),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
      10 * 60_000,
    );
    if (!response.ok) {
      throw new Error(`결과 업로드 실패: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
    }
  }

  private async finish(
    job: ClaimedJob,
    outcome: 'FAILED' | 'CANCELLED',
    error?: string,
    telemetry?: BacktestExecutionTelemetry,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(
      this.serverEndpoint(`/api/internal/workers/jobs/${job.jobId}/finish`), {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify({
        attempt: job.attempt,
        leaseToken: job.leaseToken,
        outcome,
        ...(error === undefined ? {} : { error }),
        ...(telemetry === undefined ? {} : { telemetry }),
      }),
    }, 10_000);
    if (!response.ok && response.status !== 409) {
      throw new Error(`종료 보고 실패: HTTP ${response.status}`);
    }
  }

  private jsonHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.workerToken}`,
      'content-type': 'application/json',
    };
  }

  private serverEndpoint(relativePath: string): URL {
    return new URL(relativePath, this.config.serverUrl);
  }

  private async fetchWithTimeout(
    url: URL,
    init: RequestInit & { duplex?: 'half' },
    timeoutMs: number,
  ): Promise<Response> {
    return this.withRequestTimeout(timeoutMs, (signal) =>
      fetch(url, { ...init, signal } as RequestInit & { duplex?: 'half' }));
  }

  private async withRequestTimeout<T>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    this.requestControllers.add(controller);
    if (this.stopped) controller.abort();
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timeout);
      this.requestControllers.delete(controller);
    }
  }
}

async function main(): Promise<void> {
  const supervisor = new RemoteBacktestSupervisor(loadSupervisorConfig());
  process.on('SIGINT', () => supervisor.stop('SIGINT'));
  process.on('SIGTERM', () => supervisor.stop('SIGTERM'));
  await supervisor.run();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
