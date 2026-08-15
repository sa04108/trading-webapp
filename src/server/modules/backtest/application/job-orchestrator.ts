import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../../bootstrap/config.js';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import type { BacktestExecutionTelemetry } from './backtest-execution-telemetry.js';
import type { BacktestJobRow, JobQueue } from './job-queue.js';

/** 자식 → 부모 IPC 메시지. 종료 상태는 IPC 가 아니라 DB 에 기록된다 (exit 시 부모가 읽음). */
export type ChildMessage =
  | {
      type: 'progress';
      processedBars: number;
      totalBars: number;
      progressLabel: string | null;
    }
  | { type: 'telemetry'; telemetry: BacktestExecutionTelemetry };

export interface JobEvent {
  jobId: string;
  kind: 'progress' | 'status';
}

const POLL_INTERVAL_MS = 1_000;
/** IPC 취소가 이 시간 안에 처리되지 않으면 신호로 강제한다 */
const CANCEL_SIGTERM_DELAY_MS = 5_000;
const CANCEL_SIGKILL_DELAY_MS = 10_000;

/**
 * 취소가 §10 시퀀스의 어느 단계에서 끝났는지.
 *
 * 세 경로 모두 최종 상태가 CANCELLED 라서 상태만으로는 구분되지 않는다 — IPC 경로가
 * 조용히 고장 나도(자식이 메시지를 안 듣게 되는 변경 등) 취소는 여전히 "성공" 으로
 * 보이고, 실제로는 매번 5초를 기다린 뒤 프로세스를 죽이고 있게 된다. 그래서 끝난
 * 단계를 backtest.finished 감사 기록에 남긴다: 운영에서는 "요즘 취소가 자꾸 신호까지
 * 간다" 를 볼 수 있고, 테스트는 시계를 재는 대신 이 값을 확인할 수 있다.
 */
export type CancelPath = 'IPC' | 'SIGTERM' | 'SIGKILL';

interface CancelEscalation {
  path: CancelPath;
  timers: NodeJS.Timeout[];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 작업 오케스트레이터 (스펙 §5, §10):
 * 큐를 폴링해 동시 실행 상한(기본 1) 내에서 자식 프로세스를 fork 한다.
 * 자식에는 §5 화이트리스트 환경변수만 전달한다 (비밀값 전달 금지).
 */
export class JobOrchestrator {
  readonly events = new EventEmitter();
  private readonly children = new Map<string, ChildProcess>();
  private readonly cancelEscalations = new Map<string, CancelEscalation>();
  private readonly executionTelemetry = new Map<string, BacktestExecutionTelemetry>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly workerId = `worker-${process.pid}`;

  constructor(
    private readonly queue: JobQueue,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly audit: AuditLogService,
    private readonly clock: Clock,
  ) {}

  start(): void {
    this.recoverOrphaned(true);
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  /** 모드별 실행기를 시작하기 전, 이전 모드에서 남은 활성 행을 정리한다. */
  recoverOrphaned(interruptRemoteLeases = false): void {
    const recovered = [
      ...this.queue.recoverInterrupted(isPidAlive),
      ...(interruptRemoteLeases ? this.queue.interruptActiveRemoteLeases() : []),
    ];
    if (recovered.length > 0) {
      this.logger.warn(
        { module: 'backtest', event: 'jobs.recovered', jobIds: recovered },
        'marked orphaned jobs INTERRUPTED',
      );
      // 알림 wiring 이 이 이벤트를 구독한다 — 여기서 emit 하지 않으면 재시작으로
      // INTERRUPTED 된 잡은 사용자에게 알려지지 않는다 (container 는 start() 전에 구독한다)
      for (const jobId of recovered) {
        this.events.emit('job', { jobId, kind: 'status' } satisfies JobEvent);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const child of this.children.values()) child.kill('SIGTERM');
  }

  runningCount(): number {
    return this.children.size;
  }

  /** 테스트용: 즉시 한 번 폴링 */
  tick(): void {
    if (this.children.size >= this.config.maxConcurrentBacktests) return;
    const job = this.queue.claimNext(this.workerId);
    if (!job) return;
    this.spawn(job);
  }

  cancel(jobId: string): 'CANCELLED' | 'CANCELLING' | 'NOT_CANCELLABLE' {
    const job = this.queue.getJob(jobId);
    if (!job) return 'NOT_CANCELLABLE';

    if (job.status === 'QUEUED') {
      if (!this.queue.setStatus(jobId, 'CANCELLED', {}, ['QUEUED'])) return 'NOT_CANCELLABLE';
      this.audit.record('admin', 'backtest.cancelled', { jobId });
      this.events.emit('job', { jobId, kind: 'status' } satisfies JobEvent);
      return 'CANCELLED';
    }

    const child = this.children.get(jobId);
    if (
      (job.status === 'RUNNING' || job.status === 'STARTING')
      && child === undefined
      && job.workerId?.startsWith('remote:') === true
    ) {
      if (!this.queue.setStatus(jobId, 'CANCELLING', {}, ['RUNNING', 'STARTING'])) {
        return 'NOT_CANCELLABLE';
      }
      this.audit.record('admin', 'backtest.cancel-requested', {
        jobId,
        executionMode: 'remote',
      });
      this.events.emit('job', { jobId, kind: 'status' } satisfies JobEvent);
      return 'CANCELLING';
    }
    if ((job.status === 'RUNNING' || job.status === 'STARTING') && child) {
      // 취소 시퀀스 (스펙 §10): CANCELLING → IPC → SIGTERM → SIGKILL
      this.queue.setStatus(jobId, 'CANCELLING', {}, ['RUNNING', 'STARTING']);
      this.events.emit('job', { jobId, kind: 'status' } satisfies JobEvent);
      child.send({ type: 'cancel' });

      // 단계를 올릴 때마다 기록한다. 자식이 이미 끝났으면(children 에서 빠졌으면)
      // 올리지 않는다 — 죽은 자식에게 신호를 쏘지 않고, IPC 로 끝난 취소를 신호로
      // 끝난 것처럼 기록하지도 않는다.
      const escalation: CancelEscalation = { path: 'IPC', timers: [] };
      const escalate = (to: Exclude<CancelPath, 'IPC'>, signal: 'SIGTERM' | 'SIGKILL'): void => {
        if (!this.children.has(jobId)) return;
        escalation.path = to;
        this.logger.warn(
          { module: 'backtest', event: 'backtest.cancel.escalated', jobId, to },
          'cancel escalated to signal',
        );
        child.kill(signal);
      };
      const sigterm = setTimeout(() => escalate('SIGTERM', 'SIGTERM'), CANCEL_SIGTERM_DELAY_MS);
      sigterm.unref();
      const sigkill = setTimeout(() => escalate('SIGKILL', 'SIGKILL'), CANCEL_SIGKILL_DELAY_MS);
      sigkill.unref();
      escalation.timers = [sigterm, sigkill];
      this.cancelEscalations.set(jobId, escalation);

      this.audit.record('admin', 'backtest.cancel-requested', { jobId });
      return 'CANCELLING';
    }

    return 'NOT_CANCELLABLE';
  }

  private resolveWorker(): { workerPath: string; execArgv: string[] } {
    const isTsRuntime = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(
      `../../../../workers/backtest-child.${isTsRuntime ? 'ts' : 'js'}`,
      import.meta.url,
    );
    return {
      workerPath: fileURLToPath(workerUrl),
      execArgv: isTsRuntime ? ['--import', 'tsx'] : [],
    };
  }

  private spawn(job: BacktestJobRow): void {
    const { workerPath, execArgv } = this.resolveWorker();

    // 스펙 §5: 화이트리스트 env 만 전달. 비밀값(세션 secret, 증권사 키 등) 금지.
    const env: Record<string, string> = {
      NODE_ENV: this.config.nodeEnv,
      DATABASE_PATH: this.config.databasePath,
      BACKTEST_JOB_ID: job.id,
    };
    if (process.platform === 'win32') {
      // Windows 에서 프로세스 기동에 필요한 비밀 아닌 시스템 변수
      if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
      if (process.env.TEMP) env.TEMP = process.env.TEMP;
    }

    const child = fork(workerPath, [job.id], {
      env,
      execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    this.children.set(job.id, child);
    this.queue.setStatus(job.id, 'STARTING', { pid: child.pid ?? null }, ['STARTING']);
    this.audit.record('system', 'backtest.started', { jobId: job.id, pid: child.pid });
    this.events.emit('job', { jobId: job.id, kind: 'status' } satisfies JobEvent);

    child.stdout?.on('data', (chunk: Buffer) =>
      this.logger.debug({ module: 'backtest-child', jobId: job.id }, chunk.toString().trim()),
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      this.logger.warn({ module: 'backtest-child', jobId: job.id }, chunk.toString().trim()),
    );

    let markedRunning = false;
    child.on('message', (message: ChildMessage) => {
      if (this.stopped) return;
      if (message.type === 'telemetry') {
        this.executionTelemetry.set(job.id, message.telemetry);
        this.logger.info(
          { module: 'backtest', event: 'backtest.telemetry', jobId: job.id, ...message.telemetry },
          'backtest execution telemetry',
        );
        return;
      }
      try {
        // STARTING → RUNNING 은 여기서만 일어나는 명시적 1회 전이다.
        // 진행률 갱신은 상태를 건드리지 않는다 — 종료 상태를 되돌릴 수 없다.
        if (!markedRunning) {
          markedRunning = true;
          this.queue.markRunning(job.id);
        }
        this.queue.updateProgress(
          job.id,
          message.processedBars,
          message.totalBars,
          message.progressLabel,
        );
        this.events.emit('job', { jobId: job.id, kind: 'progress' } satisfies JobEvent);
      } catch (error) {
        this.logger.warn({ module: 'backtest', jobId: job.id, err: error }, 'progress update failed');
      }
    });

    child.on('exit', (code, signal) => {
      this.children.delete(job.id);
      const telemetry = this.executionTelemetry.get(job.id);
      this.executionTelemetry.delete(job.id);
      // 남은 폴백 타이머를 끈다 — 종료한 자식에게 신호를 쏘지 않고, 늦게 발사된
      // 타이머가 이미 끝난 취소의 단계를 덧칠하지도 않게 한다.
      const escalation = this.cancelEscalations.get(job.id);
      if (escalation) {
        for (const timer of escalation.timers) clearTimeout(timer);
        this.cancelEscalations.delete(job.id);
      }
      if (this.stopped) return; // 셧다운 중 — DB 가 이미 닫혔을 수 있다

      try {
        const current = this.queue.getJob(job.id);
        if (!current) return;

        // 자식이 종료 전 최종 상태를 DB 에 기록한다. 기록 없이 죽었으면 여기서 정리.
        if (!this.queue.isTerminal(current.status)) {
          if (current.status === 'CANCELLING') {
            this.queue.setStatus(job.id, 'CANCELLED', {}, ['CANCELLING']);
          } else {
            this.queue.setStatus(
              job.id,
              'FAILED',
              {
                error: `백테스트 프로세스가 비정상 종료되었습니다 (code=${code}, signal=${signal ?? 'none'})`,
              },
              ['STARTING', 'RUNNING'],
            );
          }
        }
        this.audit.record('system', 'backtest.finished', {
          jobId: job.id,
          status: this.queue.getJob(job.id)?.status,
          durationMs: this.clock.now() - (current.startedAtMs ?? current.createdAtMs),
          ...(telemetry ? { executionTelemetry: telemetry } : {}),
          // 취소로 끝난 작업만 갖는 값 — 어느 단계가 실제로 프로세스를 끝냈는지
          ...(escalation ? { cancelPath: escalation.path } : {}),
        });
        this.events.emit('job', { jobId: job.id, kind: 'status' } satisfies JobEvent);
      } catch (error) {
        this.logger.warn({ module: 'backtest', jobId: job.id, err: error }, 'exit handling failed');
      }
    });
  }
}
