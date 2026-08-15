/**
 * 알림 생산자 연결 (설계 2026-08-03-notification-center,
 * 2026-08-08-notification-body-and-korean-names).
 *
 * backtest 모듈이 notification 모듈을 import 하지 않도록 container 가 이 listener 를
 * orchestrator.events 에 건다 — facts-wiring 과 같은 관례로, 테스트가 겨눌 수 있는
 * 자리에 둔다.
 */
import type { JobEvent } from '../modules/backtest/application/job-orchestrator.js';
import type { BacktestJobRow, JobQueue } from '../modules/backtest/application/job-queue.js';
import type {
  SeedCloneBatchDetail,
  SeedCloneBatchEvent,
} from '../modules/backtest/application/seed-clone-batch-service.js';
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

/**
 * 부호 붙은 백분율. 웹 `formatSignedPct` 와 규칙이 같다 — 공유하려면 `src/shared` 에
 * 서식 모듈을 새로 만들고 웹을 그쪽으로 돌려야 해서 여기 둔다.
 */
function signedPct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/** 저장된 경고 원문. 깨진 JSON 은 빈 배열로 — 설명 조립 실패가 알림을 없애면 안 된다 */
function parseSubmitWarnings(json: string | null, logger: Logger, jobId: string): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch (error) {
    logger.warn(
      { module: 'notification', event: 'notify.warnings.parse_failed', jobId, err: error },
      'submit warnings parse failed',
    );
    return [];
  }
}

export function createBacktestNotificationListener(deps: {
  queue: Pick<JobQueue, 'getJob'>;
  /** 전략 한국어 이름. 등록이 풀린 전략은 null — 그때는 strategyId 를 적는다 */
  strategyName: (strategyId: string) => string | null;
  /** backtest_metrics.total_return_pct. 결과가 없으면 null */
  totalReturnPct: (jobId: string) => number | null;
  notify: (input: NotificationInput) => void;
  logger: Logger;
}): (event: JobEvent) => void {
  return (event) => {
    if (event.kind !== 'status') return;
    // 알림 실패가 orchestrator 의 emit 경로를 끊으면 안 된다 — 삼키고 warn 만 남긴다
    try {
      const job: BacktestJobRow | null | undefined = deps.queue.getJob(event.jobId);
      if (!job) return;
      // 난수 시드 실험은 최대 100개 자식이 끝난다. 자식별 알림은 센터를 덮으므로
      // 배치 서비스의 최종 전이 알림 하나가 대신한다.
      if (job.cloneBatchId !== null && job.cloneBatchId !== undefined) return;
      const terminal = TERMINAL_NOTIFICATIONS[job.status];
      if (!terminal) return;

      const label = deps.strategyName(job.strategyId) ?? job.strategyId;
      // 접힌 행은 한 줄만 보인다(notifications-page.tsx) — 첫 줄이 이름과 결과를 진다
      const headline = ((): string => {
        if (job.status === 'FAILED' && job.error) return `${label} — ${job.error}`;
        if (job.status !== 'COMPLETED') return label;
        const pct = deps.totalReturnPct(job.id);
        // 결과 기록 없이 완료로 표시된 잡이다. `수익률 -` 은 "0에 가깝다" 로 읽힌다
        return pct === null ? label : `${label} · 수익률 ${signedPct(pct)}`;
      })();

      const warnings = parseSubmitWarnings(job.submitWarningsJson, deps.logger, job.id);
      deps.notify({
        type: 'backtest',
        severity: terminal.severity,
        title: terminal.title,
        body: [headline, ...warnings.map((w) => `경고: ${w}`)].join('\n'),
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

const BATCH_TERMINAL_TITLES: Record<SeedCloneBatchEvent['status'], string> = {
  COMPLETED: '난수 시드 실험이 완료되었습니다',
  FAILED: '난수 시드 실험이 실패했습니다',
  CANCELLED: '난수 시드 실험이 취소되었습니다',
};

/** 자식 알림 대신 배치가 최종 상태로 한 번 전이될 때 만드는 요약 알림. */
export function createSeedCloneBatchNotificationListener(deps: {
  getBatch: (batchId: string) => SeedCloneBatchDetail | null;
  strategyName: (strategyId: string) => string | null;
  notify: (input: NotificationInput) => void;
  logger: Logger;
}): (event: SeedCloneBatchEvent) => void {
  return (event) => {
    try {
      const detail = deps.getBatch(event.batchId);
      if (!detail) return;
      const statuses = detail.items.map(({ item, job }) => {
        if (item.state === 'PENDING') return 'PENDING';
        if (item.state === 'CANCELLED') return 'CANCELLED';
        return job?.status ?? 'DELETED';
      });
      const count = (status: string): number =>
        statuses.filter((candidate) => candidate === status).length;
      const completed = count('COMPLETED');
      const failed = count('FAILED');
      const cancelled = count('CANCELLED');
      const interrupted = count('INTERRUPTED');
      const deleted = count('DELETED');
      const pending = count('PENDING');
      const label = deps.strategyName(detail.batch.strategyId) ?? detail.batch.strategyId;

      deps.notify({
        type: 'backtest',
        severity: event.status === 'FAILED' || failed + interrupted > 0 ? 'error' : 'info',
        title: BATCH_TERMINAL_TITLES[event.status],
        body:
          `${label} · 총 ${detail.batch.totalCount}개\n` +
          `완료 ${completed} · 실패 ${failed} · 취소 ${cancelled} · 중단 ${interrupted} · ` +
          `미실행 ${pending} · 삭제 ${deleted}`,
        link: `/backtests/batches/${event.batchId}`,
      });
    } catch (error) {
      deps.logger.warn(
        {
          module: 'notification',
          event: 'notify.seed_clone_batch.failed',
          batchId: event.batchId,
          err: error,
        },
        'seed clone batch notification failed',
      );
    }
  };
}
