/**
 * 알림 생산자 연결 (설계 2026-08-03-notification-center).
 *
 * backtest 모듈이 notification 모듈을 import 하지 않도록 container 가 이 listener 를
 * orchestrator.events 에 건다 — facts-wiring 과 같은 관례로, 테스트가 겨눌 수 있는
 * 자리에 둔다.
 */
import type { JobEvent } from '../modules/backtest/application/job-orchestrator.js';
import type { BacktestJobRow, JobQueue } from '../modules/backtest/application/job-queue.js';
import type { NotificationInput } from '../modules/notification/application/notification-service.js';
import type { Logger } from '../shared/logger.js';

// status 컬럼은 리터럴 유니온이 아니라 text() 라 string 이다 — Record 키를
// BacktestJobRow['status'] 로 두면 string 전체가 키가 되어 의미가 없으므로 string 으로 둔다
const TERMINAL_NOTIFICATIONS: Partial<Record<string, { title: string; severity: 'info' | 'error' }>> =
  {
    COMPLETED: { title: '백테스트가 완료되었습니다', severity: 'info' },
    FAILED: { title: '백테스트가 실패했습니다', severity: 'error' },
    CANCELLED: { title: '백테스트가 취소되었습니다', severity: 'info' },
    INTERRUPTED: { title: '백테스트가 중단되었습니다', severity: 'error' },
  };

export function createBacktestNotificationListener(deps: {
  queue: Pick<JobQueue, 'getJob'>;
  notify: (input: NotificationInput) => void;
  logger: Logger;
}): (event: JobEvent) => void {
  return (event) => {
    if (event.kind !== 'status') return;
    // 알림 실패가 orchestrator 의 emit 경로를 끊으면 안 된다 — 삼키고 warn 만 남긴다
    try {
      const job: BacktestJobRow | null | undefined = deps.queue.getJob(event.jobId);
      if (!job) return;
      const terminal = TERMINAL_NOTIFICATIONS[job.status];
      if (!terminal) return;
      deps.notify({
        type: 'backtest',
        severity: terminal.severity,
        title: terminal.title,
        body:
          job.status === 'FAILED' && job.error
            ? `${job.strategyId} — ${job.error}`
            : job.strategyId,
        link: `/backtests/${job.id}`,
      });
    } catch (error) {
      deps.logger.warn(
        { module: 'notification', event: 'notify.backtest.failed', jobId: event.jobId, err: error },
        'backtest notification failed',
      );
    }
  };
}
