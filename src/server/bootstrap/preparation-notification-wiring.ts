import { eq } from 'drizzle-orm';
import type { BacktestPreparationJobDto } from '../modules/backtest/application/backtest-preparation-orchestrator.js';
import type { NotificationInput } from '../modules/notification/application/notification-service.js';
import type { DatabaseHandle } from '../shared/db/database.js';
import { backtestPreparationJobs } from '../shared/db/schema.js';
import type { Logger } from '../shared/logger.js';

const TERMINAL_NOTIFICATIONS = {
  COMPLETED: { title: '유니버스 미리보기가 완료되었습니다', severity: 'info' },
  FAILED: { title: '유니버스 미리보기가 실패했습니다', severity: 'error' },
  CANCELLED: { title: '유니버스 미리보기가 취소되었습니다', severity: 'info' },
} as const;

interface PreparationNotificationDetails {
  readonly strategyId: string | null;
  readonly period: string;
}

/** 저장 요청이 깨져 있어도 종료 알림 자체는 빠뜨리지 않는다. */
function parseNotificationDetails(requestJson: string): PreparationNotificationDetails {
  try {
    const value: unknown = JSON.parse(requestJson);
    if (typeof value !== 'object' || value === null) {
      return { strategyId: null, period: '기간 정보 없음' };
    }
    const record = value as Record<string, unknown>;
    const strategyId = typeof record.strategyId === 'string' && record.strategyId.length > 0
      ? record.strategyId
      : null;
    const rawPeriod = record.period;
    const period = typeof rawPeriod === 'object' && rawPeriod !== null
      ? rawPeriod as Record<string, unknown>
      : null;
    const from = typeof period?.from === 'string' ? period.from : null;
    const to = typeof period?.to === 'string' ? period.to : null;
    return {
      strategyId,
      period: from !== null && to !== null ? `${from} ~ ${to}` : '기간 정보 없음',
    };
  } catch {
    return { strategyId: null, period: '기간 정보 없음' };
  }
}

export function createPreparationNotificationListener(deps: {
  database: DatabaseHandle;
  strategyName: (strategyId: string) => string | null;
  notify: (input: NotificationInput) => void;
  logger: Logger;
}): (job: BacktestPreparationJobDto) => void {
  return (job) => {
    const terminal = TERMINAL_NOTIFICATIONS[job.status as keyof typeof TERMINAL_NOTIFICATIONS];
    if (terminal === undefined) return;

    // 알림 실패가 준비 작업의 종료 전이를 되돌리면 안 된다.
    try {
      const row = deps.database.db
        .select({ requestJson: backtestPreparationJobs.requestJson })
        .from(backtestPreparationJobs)
        .where(eq(backtestPreparationJobs.id, job.id))
        .get();
      const details = row === undefined
        ? { strategyId: null, period: '기간 정보 없음' }
        : parseNotificationDetails(row.requestJson);
      const strategyLabel = details.strategyId === null
        ? '알 수 없는 전략'
        : deps.strategyName(details.strategyId) ?? details.strategyId;
      const body = [
        `${strategyLabel} · ${details.period}`,
        ...(job.status !== 'COMPLETED' && job.error ? [job.error] : []),
      ].join('\n');

      deps.notify({
        type: 'backtest',
        severity: terminal.severity,
        title: terminal.title,
        body,
        link: '/backtests/new',
      });
    } catch (error) {
      deps.logger.warn(
        {
          module: 'notification',
          event: 'notify.preparation.failed',
          preparationJobId: job.id,
          err: error,
        },
        '유니버스 미리보기 알림 생성에 실패했습니다',
      );
    }
  };
}
