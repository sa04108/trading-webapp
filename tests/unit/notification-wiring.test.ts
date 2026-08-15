import { describe, expect, it } from 'vitest';
import {
  createBacktestNotificationListener,
  createSeedCloneBatchNotificationListener,
} from '../../src/server/bootstrap/notification-wiring.js';
import type { NotificationInput } from '../../src/server/modules/notification/application/notification-service.js';
import type { BacktestJobRow } from '../../src/server/modules/backtest/application/job-queue.js';
import type { SeedCloneBatchDetail } from '../../src/server/modules/backtest/application/seed-clone-batch-service.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));

function fakeJob(overrides: Partial<BacktestJobRow>): BacktestJobRow {
  return {
    id: 'bt_1',
    status: 'COMPLETED',
    strategyId: 'cross-sectional-momentum',
    error: null,
    submitWarningsJson: null,
    ...overrides,
  } as BacktestJobRow;
}

function harness(
  job: BacktestJobRow | null,
  options: {
    strategyName?: (strategyId: string) => string | null;
    totalReturnPct?: (jobId: string) => number | null;
  } = {},
) {
  const created: NotificationInput[] = [];
  const listener = createBacktestNotificationListener({
    queue: { getJob: () => job },
    strategyName: options.strategyName ?? (() => '횡단면 모멘텀'),
    totalReturnPct: options.totalReturnPct ?? (() => 12.345),
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

  it('완료 알림의 첫 줄에 전략 한국어 이름과 수익률을 함께 담는다', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    // 접힌 행은 한 줄만 보인다 — 이름과 수익률이 그 한 줄에 있어야 한다
    expect(created[0]?.body?.split('\n')[0]).toBe('횡단면 모멘텀 · 수익률 +12.35%');
  });

  it('손실은 + 없이 음수로 적는다', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }), {
      totalReturnPct: () => -8.9,
    });
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe('횡단면 모멘텀 · 수익률 -8.90%');
  });

  it('완료인데 수익률을 못 읽으면 이름만 남긴다 — "-" 는 0 근처로 읽힌다', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }), {
      totalReturnPct: () => null,
    });
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe('횡단면 모멘텀');
  });

  it('취소·중단은 수익률을 적지 않는다', () => {
    const { created, listener } = harness(fakeJob({ status: 'CANCELLED' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe('횡단면 모멘텀');
  });

  it('marks FAILED as error severity and includes the error message', () => {
    const { created, listener } = harness(fakeJob({ status: 'FAILED', error: '메모리 부족' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.severity).toBe('error');
    expect(created[0]?.body).toBe('횡단면 모멘텀 — 메모리 부족');
  });

  it('marks INTERRUPTED as error severity — 재시작으로 고아가 된 잡도 사용자에게 알려야 한다', () => {
    const { created, listener } = harness(fakeJob({ status: 'INTERRUPTED' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.severity).toBe('error');
    expect(created[0]?.title).toBe('백테스트가 중단되었습니다');
  });

  it('제출 경고를 첫 줄 아래에 한 줄씩 붙인다', () => {
    const { created, listener } = harness(
      fakeJob({
        status: 'COMPLETED',
        submitWarningsJson: JSON.stringify(['005930 gap 이 있습니다', '기간이 최근입니다']),
      }),
    );
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe(
      '횡단면 모멘텀 · 수익률 +12.35%\n경고: 005930 gap 이 있습니다\n경고: 기간이 최근입니다',
    );
  });

  it('등록이 풀린 전략은 strategyId 로 적는다', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }), {
      strategyName: () => null,
    });
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe('cross-sectional-momentum · 수익률 +12.35%');
  });

  it('경고 JSON 이 깨져도 알림은 나간다 — 설명 조립 실패가 알림을 없애면 안 된다', () => {
    const { created, listener } = harness(
      fakeJob({ status: 'COMPLETED', submitWarningsJson: '{깨진 JSON' }),
    );
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created).toHaveLength(1);
    expect(created[0]?.body).toBe('횡단면 모멘텀 · 수익률 +12.35%');
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

  it('난수 시드 실험 자식은 개별 종료 알림을 만들지 않는다', () => {
    const { created, listener } = harness(
      fakeJob({ status: 'COMPLETED', cloneBatchId: 'btb_1' }),
    );
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created).toEqual([]);
  });

  it('수익률 조회가 던져도 orchestrator 로 새지 않는다', () => {
    const { listener } = harness(fakeJob({ status: 'COMPLETED' }), {
      totalReturnPct: () => {
        throw new Error('db closed');
      },
    });
    expect(() => listener({ jobId: 'bt_1', kind: 'status' })).not.toThrow();
  });

  it('swallows notify failures — the orchestrator must not throw', () => {
    const listener = createBacktestNotificationListener({
      queue: { getJob: () => fakeJob({ status: 'COMPLETED' }) },
      strategyName: () => '횡단면 모멘텀',
      totalReturnPct: () => 1,
      notify: () => {
        throw new Error('insert failed');
      },
      logger,
    });
    expect(() => listener({ jobId: 'bt_1', kind: 'status' })).not.toThrow();
  });
});

describe('createSeedCloneBatchNotificationListener', () => {
  it('자식 상태를 집계한 배치 종료 알림을 한 건 만든다', () => {
    const created: NotificationInput[] = [];
    const detail = {
      batch: {
        id: 'btb_1',
        strategyId: 'cross-sectional-momentum',
        totalCount: 5,
      },
      items: [
        { item: { state: 'DISPATCHED' }, job: { status: 'COMPLETED' } },
        { item: { state: 'DISPATCHED' }, job: { status: 'COMPLETED' } },
        { item: { state: 'DISPATCHED' }, job: { status: 'FAILED' } },
        { item: { state: 'CANCELLED' }, job: null },
        { item: { state: 'DISPATCHED' }, job: { status: 'INTERRUPTED' } },
      ],
    } as unknown as SeedCloneBatchDetail;
    const listener = createSeedCloneBatchNotificationListener({
      getBatch: () => detail,
      strategyName: () => '횡단면 모멘텀',
      notify: (input) => created.push(input),
      logger,
    });

    listener({ batchId: 'btb_1', status: 'COMPLETED' });

    expect(created).toEqual([
      expect.objectContaining({
        severity: 'error',
        title: '난수 시드 실험이 완료되었습니다',
        body: '횡단면 모멘텀 · 총 5개\n완료 2 · 실패 1 · 취소 1 · 중단 1 · 미실행 0 · 삭제 0',
        link: '/backtests/batches/btb_1',
      }),
    ]);
  });
});
