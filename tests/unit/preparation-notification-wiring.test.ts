import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreparationNotificationListener } from '../../src/server/bootstrap/preparation-notification-wiring.js';
import type { BacktestPreparationJobDto } from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';
import type { NotificationInput } from '../../src/server/modules/notification/application/notification-service.js';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { backtestPreparationJobs } from '../../src/server/shared/db/schema.js';
import type { Logger } from '../../src/server/shared/logger.js';

const warn = vi.fn();
const LOGGER = { debug() {}, info() {}, warn, error() {} } as unknown as Logger;
const handles: DatabaseHandle[] = [];

function job(status: BacktestPreparationJobDto['status'], error: string | null = null) {
  return {
    id: 'prep_1',
    requestHash: 'hash',
    status,
    phase: 'FINALIZING',
    overallProgress: status === 'COMPLETED' ? 100 : 99,
    doneSymbols: 1,
    totalSymbols: 1,
    savedFacts: 0,
    gapCount: 0,
    nextResumeAtMs: null,
    error,
  } satisfies BacktestPreparationJobDto;
}

function harness(requestJson: string = JSON.stringify({
  strategyId: 'cross-sectional-momentum',
  period: { from: '2026-01-01', to: '2026-06-30' },
})) {
  const database = openDatabase(':memory:');
  handles.push(database);
  database.db.insert(backtestPreparationJobs).values({
    id: 'prep_1',
    requestHash: 'hash',
    requestJson,
    status: 'RUNNING',
    phase: 'FINALIZING',
    createdAtMs: 1,
    updatedAtMs: 1,
  }).run();
  const notifications: NotificationInput[] = [];
  const listener = createPreparationNotificationListener({
    database,
    strategyName: (strategyId) => strategyId === 'cross-sectional-momentum'
      ? '횡단면 모멘텀'
      : null,
    notify: (input) => notifications.push(input),
    logger: LOGGER,
  });
  return { database, listener, notifications };
}

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
  vi.clearAllMocks();
});

describe('createPreparationNotificationListener', () => {
  it.each([
    ['COMPLETED', '유니버스 미리보기가 완료되었습니다', 'info', null],
    ['FAILED', '유니버스 미리보기가 실패했습니다', 'error', '데이터 수집 실패'],
    ['CANCELLED', '유니버스 미리보기가 취소되었습니다', 'info', '사용자가 취소했습니다'],
  ] as const)('%s 종료 알림을 만든다', (status, title, severity, error) => {
    const { listener, notifications } = harness();

    listener(job(status, error));

    expect(notifications).toEqual([{
      type: 'backtest',
      severity,
      title,
      body: [
        '횡단면 모멘텀 · 2026-01-01 ~ 2026-06-30',
        ...(error === null ? [] : [error]),
      ].join('\n'),
      link: '/backtests/new',
    }]);
  });

  it('종료 전 상태는 데이터베이스를 조회하지 않고 무시한다', () => {
    const { database, listener, notifications } = harness();
    const prepare = vi.spyOn(database.sqlite, 'prepare');

    listener(job('RUNNING'));

    expect(notifications).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('깨진 요청 JSON도 대체 문구로 알린다', () => {
    const { listener, notifications } = harness('{깨진 JSON');

    listener(job('COMPLETED'));

    expect(notifications[0]?.body).toBe('알 수 없는 전략 · 기간 정보 없음');
  });

  it('등록되지 않은 전략은 전략 ID로 표시한다', () => {
    const { listener, notifications } = harness(JSON.stringify({
      strategyId: 'retired-strategy',
      period: { from: '2025-01-01', to: '2025-12-31' },
    }));

    listener(job('COMPLETED'));

    expect(notifications[0]?.body).toBe('retired-strategy · 2025-01-01 ~ 2025-12-31');
  });

  it('알림 저장 실패를 준비 작업 흐름으로 전파하지 않는다', () => {
    const { database } = harness();
    const listener = createPreparationNotificationListener({
      database,
      strategyName: () => '횡단면 모멘텀',
      notify: () => { throw new Error('insert failed'); },
      logger: LOGGER,
    });

    expect(() => listener(job('COMPLETED'))).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});
