import { describe, expect, it } from 'vitest';
import { createBacktestNotificationListener } from '../../src/server/bootstrap/notification-wiring.js';
import type { NotificationInput } from '../../src/server/modules/notification/application/notification-service.js';
import type { BacktestJobRow } from '../../src/server/modules/backtest/application/job-queue.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));

function fakeJob(overrides: Partial<BacktestJobRow>): BacktestJobRow {
  return {
    id: 'bt_1',
    status: 'COMPLETED',
    strategyId: 'cross-sectional-momentum',
    error: null,
    ...overrides,
  } as BacktestJobRow;
}

function harness(job: BacktestJobRow | null) {
  const created: NotificationInput[] = [];
  const listener = createBacktestNotificationListener({
    queue: { getJob: () => job },
    notify: (input) => created.push(input),
    logger,
  });
  return { created, listener };
}

describe('createBacktestNotificationListener', () => {
  it('notifies on terminal status with a link to the job', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'backtest',
      severity: 'info',
      link: '/backtests/bt_1',
    });
  });

  it('marks FAILED as error severity and includes the error message', () => {
    const { created, listener } = harness(
      fakeJob({ status: 'FAILED', error: '메모리 부족' }),
    );
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.severity).toBe('error');
    expect(created[0]?.body).toContain('메모리 부족');
  });

  it('ignores progress events, non-terminal statuses, and missing jobs', () => {
    const running = harness(fakeJob({ status: 'RUNNING' }));
    running.listener({ jobId: 'bt_1', kind: 'status' });
    running.listener({ jobId: 'bt_1', kind: 'progress' });
    expect(running.created).toEqual([]);

    const gone = harness(null);
    gone.listener({ jobId: 'bt_1', kind: 'status' });
    expect(gone.created).toEqual([]);
  });

  it('swallows notify failures — the orchestrator must not throw', () => {
    const listener = createBacktestNotificationListener({
      queue: { getJob: () => fakeJob({ status: 'COMPLETED' }) },
      notify: () => {
        throw new Error('insert failed');
      },
      logger,
    });
    expect(() => listener({ jobId: 'bt_1', kind: 'status' })).not.toThrow();
  });
});
