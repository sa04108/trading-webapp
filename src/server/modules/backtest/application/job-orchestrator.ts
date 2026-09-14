import { EventEmitter } from 'node:events';
import type { AuditLogService } from '../../audit/audit-service.js';
import type { JobQueue, BacktestJobStatus } from './job-queue.js';
import type { BacktestExecutionTelemetry } from './backtest-execution-telemetry.js';

export type ChildMessage =
  | { type: 'progress'; processedBars: number; totalBars: number; progressLabel: string | null }
  | { type: 'telemetry'; telemetry: BacktestExecutionTelemetry };
export interface JobEvent { jobId: string; kind: 'progress' | 'status' }

/** 운영 서버는 작업 상태와 취소만 관리한다. 실제 계산은 에이전트가 수행한다. */
export class JobOrchestrator {
  readonly events = new EventEmitter();
  constructor(private readonly queue: JobQueue, private readonly audit: AuditLogService) {}

  start(): void {
    for (const jobId of this.queue.recoverInterrupted(() => false)) {
      this.events.emit('job', { jobId, kind: 'status' } satisfies JobEvent);
    }
  }

  cancel(jobId: string): 'CANCELLED' | 'CANCELLING' | 'NOT_CANCELLABLE' {
    const job = this.queue.getJob(jobId);
    if (!job) return 'NOT_CANCELLABLE';
    const next = job.status === 'QUEUED' ? 'CANCELLED'
      : job.status === 'RUNNING' || job.status === 'STARTING' ? 'CANCELLING' : null;
    if (next === null || !this.queue.setStatus(jobId, next, {}, [job.status as BacktestJobStatus])) return 'NOT_CANCELLABLE';
    this.audit.record('admin', next === 'CANCELLED' ? 'backtest.cancelled' : 'backtest.cancel-requested', { jobId });
    this.events.emit('job', { jobId, kind: 'status' } satisfies JobEvent);
    return next;
  }
}
