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
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../server/modules/backtest/application/remote-worker-protocol.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  BACKTEST_SERVER_URL: z.string().url(),
  BACKTEST_WORKER_TOKEN: z.string().min(32).max(256),
  BACKTEST_WORKER_ID: z.string().regex(/^[a-zA-Z0-9._-]{1,48}$/).optional(),
  BACKTEST_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  BACKTEST_WORK_ROOT: z.string().default('./data/remote-worker'),
  BACKTEST_CLAIM_WAIT_SECONDS: z.coerce.number().int().min(1).max(25).default(25),
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
const heartbeatResponseSchema = z.object({
  status: z.literal('ACCEPTED'),
  cancelRequested: z.boolean(),
  leaseExpiresAtMs: z.number().int().nonnegative(),
});
const resultResponseSchema = z.object({
  status: z.enum(['ACCEPTED', 'IDEMPOTENT']),
});
const finishResponseSchema = z.object({ status: z.literal('ACCEPTED') });
const probeResponseSchema = z.object({
  status: z.enum(['READY', 'STANDBY']),
  runnerVersion: z.string(),
  protocolVersion: z.number().int().positive(),
});
const WORK_ROOT_MARKER = '.quant-backtest-worker-root';
const WORK_ROOT_MARKER_CONTENT = 'quant-platform remote backtest worker\n';
const WORK_ROOT_LOCK = '.supervisor.lock';

type ChildMessage =
  | { readonly type: 'progress'; readonly processedBars: number; readonly totalBars: number; readonly progressLabel: string | null }
  | { readonly type: 'telemetry'; readonly telemetry: BacktestExecutionTelemetry };

function loadSupervisorConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const parsed = envSchema.parse(env);
  const serverUrl = new URL(parsed.BACKTEST_SERVER_URL);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(serverUrl.hostname);
  if (serverUrl.protocol !== 'https:' && !(parsed.NODE_ENV !== 'production' && loopback)) {
    throw new Error('BACKTEST_SERVER_URL은 HTTPS여야 합니다 (개발 loopback만 HTTP 허용)');
  }
  if (serverUrl.username !== '' || serverUrl.password !== '') {
    throw new Error('BACKTEST_SERVER_URL에 사용자명이나 비밀번호를 넣을 수 없습니다');
  }
  if (serverUrl.pathname !== '/' || serverUrl.search !== '' || serverUrl.hash !== '') {
    throw new Error('BACKTEST_SERVER_URL에는 origin만 지정해야 합니다 (path/query/hash 금지)');
  }
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

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

class RemoteBacktestSupervisor {
  private readonly logger;
  private readonly runnerVersion: string;
  private stopped = false;
  private readonly stopController = new AbortController();
  private readonly activeChildren = new Set<ChildProcess>();
  private readonly requestControllers = new Set<AbortController>();

  constructor(private readonly config: SupervisorConfig) {
    this.runnerVersion = readGitCommitSha(config.nodeEnv);
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
    await this.prepareWorkRoot();
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
    this.stopController.abort();
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
        const claimStartedAtMs = Date.now();
        const job = await this.claim(slot);
        retryMs = 1_000;
        if (job === null) {
          // 서버·프록시 회귀로 빈 204가 너무 일찍 와도 설정된 long-poll 한 주기보다
          // 빠르게 다시 요청하지 않는다. 정상 25초 응답에는 추가 지연이 생기지 않는다.
          const remainingClaimCycleMs = this.config.claimWaitSeconds * 1_000
            - (Date.now() - claimStartedAtMs);
          if (remainingClaimCycleMs > 0) {
            // 최초 연결 수립 시간이 다음 요청보다 길어도 서버 도착 간격이 1초 아래로
            // 좁아지지 않도록, 조기 응답 뒤에는 최소 1초를 쉰다.
            await delay(Math.max(1_000, remainingClaimCycleMs), this.stopController.signal);
          }
          continue;
        }
        await this.execute(job, slot);
      } catch (error) {
        if (this.stopped) return;
        this.logger.error({ event: 'remote-worker.slot-error', slot, err: error }, 'worker slot failed');
        await delay(retryMs, this.stopController.signal);
        retryMs = Math.min(30_000, retryMs * 2);
      }
    }
  }

  private async claim(slot: number): Promise<ClaimedJob | null> {
    return this.requestWithTimeout(
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
      async (response) => {
        if (response.status === 204) return null;
        if (response.status === 409) {
          const detail = await response.text();
          throw new Error(`server/worker release 불일치: ${detail.slice(0, 500)}`);
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`claim 실패: HTTP ${response.status}`);
        }
        return claimedJobSchema.parse(await response.json());
      },
    );
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
      try {
        await fs.rmdir(path.dirname(directory));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // 다른 attempt가 아직 실행 중이면 부모 디렉터리는 그 attempt가 끝날 때 지운다.
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
          this.logger.warn(
            { event: 'remote-worker.job-parent-cleanup-failed', jobId: job.jobId, err: error },
            'remote job parent directory cleanup failed',
          );
        }
      }
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
        await response.body?.cancel();
        throw new Error(`입력 snapshot 다운로드 실패: HTTP ${response.status}`);
      }
      const checksum = response.headers.get('x-content-sha256');
      if (checksum === null || !/^[a-f0-9]{64}$/.test(checksum)) {
        await response.body.cancel();
        throw new Error('입력 snapshot checksum 헤더가 없습니다');
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
      if (contentType !== 'application/vnd.quant-platform.backtest-input+sqlite') {
        await response.body.cancel();
        throw new Error(`입력 snapshot content-type이 올바르지 않습니다: ${contentType ?? '없음'}`);
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
      await this.requestWithTimeout(
        this.serverEndpoint(`/api/internal/workers/jobs/${job.jobId}/heartbeat`), {
        method: 'POST',
        headers: this.jsonHeaders(),
        body: JSON.stringify({
          attempt: job.attempt,
          leaseToken: job.leaseToken,
          ...progress,
        }),
      }, Math.min(10_000, heartbeatMs), async (response) => {
        if (response.status === 409) {
          await response.body?.cancel();
          staleLease = true;
          requestCancel();
          return;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`heartbeat 실패: HTTP ${response.status}`);
        }
        const body = heartbeatResponseSchema.parse(await response.json());
        if (body.cancelRequested) requestCancel();
      });
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
    await this.requestWithTimeout(
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
      async (response) => {
        const detail = await response.text();
        if (!response.ok) {
          throw new Error(`결과 업로드 실패: HTTP ${response.status} ${detail.slice(0, 500)}`);
        }
        try {
          resultResponseSchema.parse(JSON.parse(detail));
        } catch (error) {
          throw new Error('결과 업로드 응답이 protocol과 일치하지 않습니다', { cause: error });
        }
      },
    );
  }

  private async finish(
    job: ClaimedJob,
    outcome: 'FAILED' | 'CANCELLED',
    error?: string,
    telemetry?: BacktestExecutionTelemetry,
  ): Promise<void> {
    await this.requestWithTimeout(
      this.serverEndpoint(`/api/internal/workers/jobs/${job.jobId}/finish`), {
        method: 'POST',
        headers: this.jsonHeaders(),
        body: JSON.stringify({
          attempt: job.attempt,
          leaseToken: job.leaseToken,
          outcome,
          ...(error === undefined ? {} : { error }),
          ...(telemetry?.outcome === outcome ? { telemetry } : {}),
        }),
      }, 10_000, async (response) => {
        if (!response.ok && response.status !== 409) {
          await response.body?.cancel();
          throw new Error(`종료 보고 실패: HTTP ${response.status}`);
        }
        if (response.status === 409) {
          await response.body?.cancel();
          return;
        }
        try {
          finishResponseSchema.parse(await response.json());
        } catch (error) {
          throw new Error('종료 보고 응답이 protocol과 일치하지 않습니다', { cause: error });
        }
      },
    );
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

  private async requestWithTimeout<T>(
    url: URL,
    init: RequestInit & { duplex?: 'half' },
    timeoutMs: number,
    handle: (response: Response) => Promise<T>,
  ): Promise<T> {
    return this.withRequestTimeout(timeoutMs, async (signal) => {
      const response = await fetch(url, {
        ...init,
        signal,
      } as RequestInit & { duplex?: 'half' });
      return handle(response);
    });
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

  private async prepareWorkRoot(): Promise<void> {
    const filesystemRoot = path.parse(this.config.workRoot).root;
    if (this.config.workRoot === filesystemRoot) {
      throw new Error('BACKTEST_WORK_ROOT에 파일시스템 루트를 사용할 수 없습니다');
    }
    await fs.mkdir(this.config.workRoot, { recursive: true, mode: 0o700 });
    const markerPath = path.join(this.config.workRoot, WORK_ROOT_MARKER);
    let marker: string | null = null;
    try {
      marker = await fs.readFile(markerPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (marker === null) {
      // 기존 릴리스가 만든 work root에는 marker가 없고 jobs 디렉터리만 있을 수 있다.
      // 그 외 파일이 있으면 잘못 지정한 일반 디렉터리일 수 있으므로 재귀 삭제 전에 멈춘다.
      const entries = await fs.readdir(this.config.workRoot);
      const unexpected = entries.filter((entry) => entry !== 'jobs' && entry !== WORK_ROOT_LOCK);
      if (unexpected.length > 0) {
        throw new Error(
          `BACKTEST_WORK_ROOT에 worker 소유가 아닌 항목이 있습니다: ${unexpected.join(', ')}`,
        );
      }
      await fs.writeFile(markerPath, WORK_ROOT_MARKER_CONTENT, { flag: 'wx', mode: 0o600 });
      marker = WORK_ROOT_MARKER_CONTENT;
    }
    if (marker !== WORK_ROOT_MARKER_CONTENT) {
      throw new Error(`BACKTEST_WORK_ROOT marker가 올바르지 않습니다: ${markerPath}`);
    }

    // Docker entrypoint가 이 경로의 advisory flock을 보유한 상태에서만 production
    // supervisor를 시작한다. PID namespace를 넘지 못하는 PID 파일 잠금은 사용하지 않는다.
    // Supervisor는 중단된 attempt를 로컬에서 재개하지 않는다. 전원 장애·SIGKILL 뒤 남은
    // 입력 DB와 결과 DB를 보존하면 민감한 입력과 디스크 사용량이 무기한 쌓이므로 시작할
    // 때 모두 지운다. marker로 소유권을 확인한 뒤에만 재귀 삭제한다.
    await fs.rm(path.join(this.config.workRoot, 'jobs'), { recursive: true, force: true });
    await fs.mkdir(path.join(this.config.workRoot, 'jobs'), { recursive: true, mode: 0o700 });
  }
}

async function checkCompatibility(config: SupervisorConfig): Promise<'READY' | 'STANDBY'> {
  const runnerVersion = readGitCommitSha(config.nodeEnv);
  if (config.nodeEnv === 'production' && runnerVersion === 'unknown') {
    throw new Error('remote worker 검사에는 dist/build-info.json의 Git SHA가 필요합니다');
  }
  const response = await fetch(new URL('/api/internal/workers/probe', config.serverUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.workerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workerId: config.workerId,
      runnerVersion,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`worker 호환성 검사 실패: HTTP ${response.status} ${detail.slice(0, 500)}`);
  }
  const body = probeResponseSchema.parse(await response.json());
  if (
    body.runnerVersion !== runnerVersion
    || body.protocolVersion !== REMOTE_WORKER_PROTOCOL_VERSION
  ) throw new Error('worker 호환성 검사 응답이 요청한 release/protocol과 일치하지 않습니다');
  return body.status;
}

async function main(): Promise<void> {
  const config = loadSupervisorConfig();
  if (process.argv.slice(2).includes('--check')) {
    const status = await checkCompatibility(config);
    process.stdout.write(`${status}\n`);
    return;
  }
  const supervisor = new RemoteBacktestSupervisor(config);
  process.on('SIGINT', () => supervisor.stop('SIGINT'));
  process.on('SIGTERM', () => supervisor.stop('SIGTERM'));
  await supervisor.run();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
