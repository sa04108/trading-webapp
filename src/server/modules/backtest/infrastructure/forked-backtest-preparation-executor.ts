import fs from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../../bootstrap/config.js';
import type { Logger } from '../../../shared/logger.js';
import {
  PreparationInputError,
  UnsafeBacktestSymbolIdentityError,
  type BacktestUniversePreview,
  type PreparationInput,
} from '../application/backtest-preparation-orchestrator.js';
import {
  PreparationExecutionBusyError,
  type BacktestPreparationExecutionLane,
  type PreparationChildMessage,
  type PreparationChildRequest,
  type PreparationNotification,
  type ReadyPreviewDetails,
  type SerializedPreparationError,
} from '../application/backtest-preparation-execution.js';
import { KrxNotConfiguredError, KrxQuotaError } from '../../market-data/application/ports.js';
import { SymbolMasterNotCoveredError } from '../../market-data/application/symbol-master-service.js';

const CANCEL_TERM_DELAY_MS = 750;
const CANCEL_KILL_DELAY_MS = 2_500;
const RSS_POLL_INTERVAL_MS = 1_000;

interface QueueEntry<T = unknown> {
  readonly request: PreparationChildRequest;
  readonly key: string;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

interface ActiveExecution {
  readonly entry: QueueEntry;
  readonly child: ChildProcess;
  readonly settled: Promise<void>;
  cancelRequested: boolean;
}

export interface ForkedPreparationExecutorOptions {
  /** Test-only child entry override; production resolves the built/source worker automatically. */
  readonly childUrl?: URL;
  /** Test seam for deterministic Linux RSS-limit coverage. */
  readonly readRssMb?: (pid: number) => number | null;
  /** Relays a row already persisted by the child to the parent's notification SSE emitter. */
  readonly onNotificationCreated?: (notification: PreparationNotification) => void;
}

/**
 * One child at a time keeps expensive better-sqlite3/JS work away from Fastify's event loop.
 * Each child performs one operation and must exit before the lane advances.
 */
export class ForkedBacktestPreparationExecutor implements BacktestPreparationExecutionLane {
  private readonly queued: QueueEntry[] = [];
  private readonly coalesced = new Map<string, Promise<unknown>>();
  private readonly updateListeners = new Set<(jobId: string) => void>();
  private readonly terminating = new WeakSet<ChildProcess>();
  private active: ActiveExecution | null = null;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly options: ForkedPreparationExecutorOptions = {},
  ) {}

  runClaimedJob(jobId: string): Promise<void> {
    return this.enqueue({ type: 'RUN_JOB', jobId }, `run:${jobId}`, true);
  }

  getReadyPreview(input: PreparationInput): Promise<BacktestUniversePreview | null> {
    return this.enqueue(
      { type: 'GET_READY_PREVIEW', input },
      `ready:${canonicalJson(input)}`,
    );
  }

  getReadyPreviewDetails(input: PreparationInput): Promise<ReadyPreviewDetails | null> {
    return this.enqueue(
      { type: 'GET_READY_PREVIEW_DETAILS', input },
      `ready-details:${canonicalJson(input)}`,
    );
  }

  getCachedPreview(input: PreparationInput): Promise<BacktestUniversePreview | null> {
    return this.enqueue(
      { type: 'GET_CACHED_PREVIEW', input },
      `cached:${canonicalJson(input)}`,
    );
  }

  needsDart(input: PreparationInput): Promise<boolean> {
    return this.enqueue({ type: 'NEEDS_DART', input }, `dart:${canonicalJson(input)}`);
  }

  onJobUpdated(listener: (jobId: string) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  cancel(jobId: string): boolean {
    let found = false;
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      const entry = this.queued[index];
      if (entry?.request.type !== 'RUN_JOB' || entry.request.jobId !== jobId) continue;
      this.queued.splice(index, 1);
      found = true;
      entry.reject(new Error('사용자가 준비 작업을 취소했습니다.'));
      this.coalesced.delete(entry.key);
    }
    if (this.active?.entry.request.type !== 'RUN_JOB') return found;
    if (this.active.entry.request.jobId !== jobId) return found;
    found = true;
    if (this.active.cancelRequested) return found;
    this.active.cancelRequested = true;
    this.stopChild(this.active.child, { type: 'CANCEL', jobId });
    return found;
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.active?.settled;
    this.stopping = true;
    const error = new Error('준비 실행 레인이 종료 중입니다.');
    for (const entry of this.queued.splice(0)) {
      entry.reject(error);
      this.coalesced.delete(entry.key);
    }
    if (this.active !== null) {
      this.stopChild(this.active.child, { type: 'SHUTDOWN' });
      await this.active.settled;
    }
  }

  private enqueue<T>(
    request: PreparationChildRequest,
    key: string,
    durable = false,
  ): Promise<T> {
    const existing = this.coalesced.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    if (this.stopping) return Promise.reject(new Error('준비 실행 레인이 종료 중입니다.'));
    if (!durable && this.queued.length >= this.config.preparationExecutionMaxQueued) {
      return Promise.reject(new PreparationExecutionBusyError());
    }
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: QueueEntry<T> = { request, key, resolve, reject };
    if (durable) this.queued.unshift(entry as QueueEntry);
    else this.queued.push(entry as QueueEntry);
    this.coalesced.set(key, promise);
    this.pump();
    return promise;
  }

  private pump(): void {
    if (this.stopping || this.active !== null) return;
    const entry = this.queued.shift();
    if (entry === undefined) return;
    let child: ChildProcess;
    try {
      child = this.spawnChild();
    } catch (error) {
      this.coalesced.delete(entry.key);
      entry.reject(error);
      queueMicrotask(() => this.pump());
      return;
    }
    let response: PreparationChildMessage | null = null;
    let processError: Error | null = null;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const active: ActiveExecution = { entry, child, settled, cancelRequested: false };
    this.active = active;

    const rssTimer = this.monitorRss(child, (rssMb) => {
      processError = new Error(
        `준비 자식 프로세스 RSS가 설정 상한(${this.config.preparationChildMaxRssMb} MiB)을 `
        + `초과했습니다: ${rssMb} MiB`,
      );
      this.stopChild(child, { type: 'SHUTDOWN' }, true);
    });

    child.stdout?.on('data', (chunk: Buffer) => this.logger.debug(
      { module: 'preparation-child' }, chunk.toString().trim(),
    ));
    child.stderr?.on('data', (chunk: Buffer) => this.logger.warn(
      { module: 'preparation-child' }, chunk.toString().trim(),
    ));
    child.on('message', (raw: unknown) => {
      if (!isPreparationChildMessage(raw)) {
        processError = new Error('준비 자식 프로세스가 잘못된 IPC 메시지를 보냈습니다.');
        this.stopChild(child, { type: 'SHUTDOWN' });
        return;
      }
      if (raw.type === 'JOB_UPDATED') {
        for (const listener of this.updateListeners) {
          try {
            listener(raw.jobId);
          } catch (error) {
            this.logger.warn(
              { module: 'preparation-child', event: 'job-update-listener-failed', err: error },
              'preparation child job update listener failed',
            );
          }
        }
        return;
      }
      if (raw.type === 'NOTIFICATION_CREATED') {
        try {
          this.options.onNotificationCreated?.(raw.notification);
        } catch (error) {
          this.logger.warn(
            { module: 'preparation-child', event: 'notification-listener-failed', err: error },
            'preparation child notification listener failed',
          );
        }
        return;
      }
      if (response === null) response = raw;
    });
    child.once('error', (error) => {
      processError = error;
      this.stopChild(child, { type: 'SHUTDOWN' });
    });
    child.once('close', (code, signal) => {
      clearInterval(rssTimer);
      if (this.active === active) this.active = null;
      this.coalesced.delete(entry.key);
      if (processError !== null) {
        entry.reject(processError);
      } else if (response?.type === 'RESULT' && code === 0 && signal === null) {
        if (isValidResult(entry.request, response.value)) {
          entry.resolve(entry.request.type === 'RUN_JOB' ? undefined : response.value);
        } else entry.reject(new Error(
          `준비 자식 프로세스가 ${entry.request.type}의 잘못된 결과를 보냈습니다.`,
        ));
      } else if (response?.type === 'ERROR') {
        entry.reject(rehydrateError(response.error));
      } else {
        entry.reject(processError ?? new Error(
          `준비 자식 프로세스가 결과 없이 종료됐습니다 (code=${String(code)}, signal=${String(signal)}).`,
        ));
      }
      resolveSettled();
      this.pump();
    });
    child.send({ type: 'EXECUTE', config: this.config, request: entry.request }, (error) => {
      if (!error) return;
      processError = error;
      this.stopChild(child, { type: 'SHUTDOWN' });
    });
  }

  private spawnChild(): ChildProcess {
    const isTsRuntime = import.meta.url.endsWith('.ts');
    const childUrl = this.options.childUrl ?? new URL(
      `../../../../workers/backtest-preparation-child.${isTsRuntime ? 'ts' : 'js'}`,
      import.meta.url,
    );
    const env = { ...process.env };
    // Parent deployment flags must not silently weaken or conflict with this per-child ceiling.
    delete env.NODE_OPTIONS;
    return fork(fileURLToPath(childUrl), [], {
      env,
      execArgv: [
        ...(isTsRuntime ? ['--import', 'tsx'] : []),
        `--max-old-space-size=${this.config.preparationChildMaxOldSpaceMb}`,
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  }

  private monitorRss(child: ChildProcess, exceeded: (rssMb: number) => void): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (process.platform !== 'linux' || child.pid === undefined || child.exitCode !== null) return;
      try {
        const rssMb = this.options.readRssMb === undefined
          ? readLinuxRssMb(child.pid)
          : this.options.readRssMb(child.pid);
        if (rssMb === null) return;
        if (rssMb > this.config.preparationChildMaxRssMb) exceeded(rssMb);
      } catch {
        // A racing process exit is normal; the exit listener owns settlement.
      }
    }, RSS_POLL_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  private stopChild(
    child: ChildProcess,
    message: Record<string, unknown>,
    immediate = false,
  ): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (this.terminating.has(child)) return;
    this.terminating.add(child);
    if (immediate) {
      child.kill('SIGKILL');
      return;
    }
    if (child.connected) child.send(message, () => undefined);
    const term = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }, CANCEL_TERM_DELAY_MS);
    term.unref();
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, CANCEL_KILL_DELAY_MS);
    kill.unref();
    child.once('exit', () => {
      clearTimeout(term);
      clearTimeout(kill);
    });
  }
}

function readLinuxRssMb(pid: number): number | null {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  return match?.[1] === undefined ? null : Math.ceil(Number(match[1]) / 1024);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isPreparationChildMessage(value: unknown): value is PreparationChildMessage {
  if (value === null || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'JOB_UPDATED') return typeof message.jobId === 'string';
  if (message.type === 'NOTIFICATION_CREATED') {
    if (message.notification === null || typeof message.notification !== 'object') return false;
    const notification = message.notification as Record<string, unknown>;
    return typeof notification.id === 'string'
      && (notification.type === 'backtest' || notification.type === 'data-sync')
      && (notification.severity === 'info' || notification.severity === 'error')
      && typeof notification.title === 'string'
      && (notification.body === null || typeof notification.body === 'string')
      && (notification.link === null || typeof notification.link === 'string')
      && typeof notification.read === 'boolean'
      && typeof notification.createdAtMs === 'number';
  }
  if (message.type === 'RESULT') return Object.hasOwn(message, 'value');
  if (message.type !== 'ERROR' || message.error === null || typeof message.error !== 'object') {
    return false;
  }
  const error = message.error as Record<string, unknown>;
  return typeof error.name === 'string' && typeof error.message === 'string';
}

function isValidResult(request: PreparationChildRequest, value: unknown): boolean {
  if (request.type === 'RUN_JOB') return value === null;
  if (request.type === 'NEEDS_DART') return typeof value === 'boolean';
  if (request.type === 'GET_READY_PREVIEW_DETAILS') {
    if (value === null) return true;
    if (typeof value !== 'object') return false;
    const details = value as Record<string, unknown>;
    return isPreview(details.preview)
      && Array.isArray(details.fundamentalSymbols)
      && details.fundamentalSymbols.every((symbol) => typeof symbol === 'string');
  }
  return value === null || isPreview(value);
}

function isPreview(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const preview = value as Record<string, unknown>;
  return Array.isArray(preview.schedule)
    && Array.isArray(preview.diagnostics)
    && Array.isArray(preview.stages)
    && Array.isArray(preview.unionSymbols)
    && preview.unionSymbols.every((symbol) => typeof symbol === 'string')
    && typeof preview.scheduleHash === 'string'
    && Array.isArray(preview.uncoveredDates)
    && typeof preview.periodCovered === 'boolean'
    && Array.isArray(preview.missingCandleSymbols)
    && Array.isArray(preview.warnings);
}

function rehydrateError(error: SerializedPreparationError): Error {
  let restored: Error;
  switch (error.name) {
    case 'KrxQuotaError': restored = new KrxQuotaError(error.message); break;
    case 'KrxNotConfiguredError': restored = new KrxNotConfiguredError(); break;
    case 'SymbolMasterNotCoveredError':
      restored = new SymbolMasterNotCoveredError(error.date ?? 'unknown');
      break;
    case 'UnsafeBacktestSymbolIdentityError':
      restored = new UnsafeBacktestSymbolIdentityError(error.message);
      break;
    case 'PreparationInputError': restored = new PreparationInputError(error.message); break;
    default:
      restored = new Error(error.message);
      restored.name = error.name;
  }
  restored.message = error.message;
  if (error.stack !== undefined) restored.stack = error.stack;
  return restored;
}
