import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import { describe, expect, it, vi } from 'vitest';
import { BenchmarkService } from '../../src/server/modules/market-data/application/benchmark-service.js';
import type {
  FredBenchmarkSource,
  KrxHistoricalUniverseSource,
} from '../../src/runtime/modules/market-data/application/ports.js';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import {
  symbolMasterCoverage,
  symbolMasterTradingDays,
} from '../../src/runtime/shared/db/schema.js';
import type { Logger } from '../../src/server/shared/logger.js';
import { ProviderRequestBlockedError } from '../../src/runtime/shared/provider-request-blocked-error.js';

const logger = {
  debug() {}, info() {}, warn() {}, error() {},
} as unknown as Logger;

describe('벤치마크 저장과 결과 비교', () => {
  it('취소는 마지막 요청이 끝날 때까지 대기하고 이전 ID는 새 작업을 취소하지 않는다', async () => {
    const database = openDatabase(':memory:');
    try {
      let release!: (value: number | null) => void;
      const fetchBenchmarkClose = vi.fn(() => new Promise<number | null>((resolve) => { release = resolve; }));
      const service = new BenchmarkService({ db: database.db,
        krxSource: { fetchBenchmarkClose } as unknown as KrxHistoricalUniverseSource,
        fredSource: { fetchBenchmarkRange: async () => [] }, clock: { now: () => 123 }, logger });
      service.startBackfill('KOSPI', '2026-01-02', '2026-01-02');
      const id = service.currentJob()!.id;
      expect(service.cancelJob(id)).toBe(true);
      expect(service.currentJob()?.status).toBe('CANCELLING');
      service.startBackfill('KOSPI', '2026-01-05', '2026-01-05');
      expect(service.currentJob()?.id).toBe(id);
      release(100);
      await vi.waitFor(() => expect(service.currentJob()?.status).toBe('CANCELLED'));
      service.startBackfill('KOSPI', '2026-01-05', '2026-01-05');
      expect(service.cancelJob(id)).toBe(false);
      expect(service.currentJob()?.status).toBe('RUNNING');
      release(101);
      await vi.waitFor(() => expect(service.currentJob()?.status).toBe('COMPLETED'));
    } finally { database.close(); }
  });

  it('저장된 거래일 커버를 확인하고 이미 수집한 날짜는 다시 받지 않는다', async () => {
    const database = openDatabase(':memory:');
    try {
      const closes = new Map([
        ['KOSPI:2026-01-02', 100],
        ['KOSDAQ:2026-01-02', 800],
        ['KOSPI:2026-01-05', 110],
        ['KOSDAQ:2026-01-05', 820],
      ]);
      const fetchBenchmarkClose = vi.fn(
        async (id: 'KOSPI' | 'KOSDAQ', date: string) => closes.get(`${id}:${date}`) ?? null,
      );
      const source: KrxHistoricalUniverseSource = {
        fetchIssueBaseInfo: async () => [],
        fetchDailyTrades: async () => [],
        fetchBenchmarkClose,
        todayMaxEndpointCallCount: () => 0,
      };
      const service = new BenchmarkService({
        db: database.db,
        krxSource: source,
        fredSource: { fetchBenchmarkRange: async () => [] },
        clock: { now: () => 123 },
        logger,
      });
      database.db.insert(symbolMasterTradingDays).values([
        { date: '2026-01-02' },
        { date: '2026-01-05' },
      ]).run();
      database.db.insert(symbolMasterCoverage).values({
        startDate: '2026-01-02',
        endDate: '2026-01-05',
        collectionVersion: readRuntimeVersions().collectionVersion, syncedAtMs: 1,
      }).run();
      await service.syncDate('KOSPI', '2026-01-02');
      await service.syncDate('KOSPI', '2026-01-05');

      expect(service.status('KOSPI', '2026-01-02', '2026-01-05')).toEqual({
        covered: true, points: [{ date: '2026-01-02', close: 100 }, { date: '2026-01-05', close: 110 }],
      });

      fetchBenchmarkClose.mockClear();
      service.startBackfill('KOSPI', '2026-01-02', '2026-01-06');
      await vi.waitFor(() => expect(service.backfillStatus().state).toBe('IDLE'));
      expect(fetchBenchmarkClose).toHaveBeenCalledOnce();
      expect(fetchBenchmarkClose).toHaveBeenCalledWith('KOSPI', '2026-01-06');
    } finally {
      database.close();
    }
  });

  it('마지막 거래일 값이 있으면 그날과 직후 주말 종료 요청을 모두 커버한다', async () => {
    const database = openDatabase(':memory:');
    try {
      const closes = new Map([
        ['2026-08-13', 3_200],
        ['2026-08-14', 3_240],
      ]);
      const service = new BenchmarkService({
        db: database.db,
        krxSource: {
          fetchIssueBaseInfo: async () => [],
          fetchDailyTrades: async () => [],
          fetchBenchmarkClose: async (_id, date) => closes.get(date) ?? null,
          todayMaxEndpointCallCount: () => 0,
        },
        fredSource: { fetchBenchmarkRange: async () => [] },
        clock: { now: () => 123 },
        logger,
      });
      // 마스터 수집은 13일까지지만 벤치마크 자체는 14일 값을 확보한 운영 상태를 재현한다.
      database.db.insert(symbolMasterCoverage).values({
        startDate: '2026-08-13',
        endDate: '2026-08-13',
        collectionVersion: readRuntimeVersions().collectionVersion, syncedAtMs: 1,
      }).run();
      database.db.insert(symbolMasterTradingDays).values([
        { date: '2026-08-13' },
        { date: '2026-08-14' },
        // legacy 이벤트 이행에서 들어올 수 있는 잘못된 주말 거래일도 무시해야 한다.
        { date: '2026-08-16' },
      ]).run();
      await service.syncDate('KOSPI', '2026-08-13');
      await service.syncDate('KOSPI', '2026-08-14');

      expect(service.status('KOSPI', '2026-08-13', '2026-08-14').covered).toBe(true);
      expect(service.status('KOSPI', '2026-08-13', '2026-08-16').covered).toBe(true);
      // 확인되지 않은 다음 평일까지 휴장이라고 추측해서는 안 된다.
      expect(service.status('KOSPI', '2026-08-13', '2026-08-17').covered).toBe(false);
    } finally {
      database.close();
    }
  });

  it('종목 마스터를 먼저 수집하지 않아도 KRX 백필의 평일 휴장일을 커버한다', async () => {
    const database = openDatabase(':memory:');
    const closes = new Map([
      ['2026-01-02', 3_100],
      ['2026-01-06', 3_120],
    ]);
    const service = new BenchmarkService({
      db: database.db,
      krxSource: {
        fetchIssueBaseInfo: async () => [],
        fetchDailyTrades: async () => [],
        // 1월 5일은 평일 휴장일인 상황을 재현한다. 성공한 빈 응답을 coverage로
        // 남기지 않으면 기간 단계가 유니버스 수집 전에 영구히 막힌다.
        fetchBenchmarkClose: async (_id, date) => closes.get(date) ?? null,
        todayMaxEndpointCallCount: () => 0,
      },
      fredSource: { fetchBenchmarkRange: async () => [] },
      clock: { now: () => 456 },
      logger,
    });

    try {
      service.startBackfill('KOSPI', '2026-01-02', '2026-01-06');
      await vi.waitFor(() => expect(service.backfillStatus().state).toBe('IDLE'));

      expect(service.status('KOSPI', '2026-01-02', '2026-01-06')).toMatchObject({
        covered: true,
        points: [
          { date: '2026-01-02', close: 3_100 },
          { date: '2026-01-06', close: 3_120 },
        ],
      });
    } finally {
      database.close();
    }
  });

  it('빈 KRX 응답 대기를 실패 날짜와 원래 공급자 근거로 설명하고 해당 날짜부터 다시 동기화한다', async () => {
    const database = openDatabase(':memory:');
    const originalError = new ProviderRequestBlockedError(
      'PENDING_PUBLICATION',
      'fingerprint-123',
      'KRX_EMPTY_PENDING:{"calendar":{"state":"OPEN"},"fetchedAtMs":123}',
    );
    let shouldBlock = true;
    const errorLogs: Array<Record<string, unknown>> = [];
    const fetchBenchmarkClose = vi.fn(async (_id: 'KOSPI' | 'KOSDAQ', date: string) => {
      if (date === '2026-01-05' && shouldBlock) throw originalError;
      return date === '2026-01-02' ? 3_100 : 3_120;
    });
    const service = new BenchmarkService({
      db: database.db,
      krxSource: {
        fetchIssueBaseInfo: async () => [],
        fetchDailyTrades: async () => [],
        fetchBenchmarkClose,
        todayMaxEndpointCallCount: () => 0,
      },
      fredSource: { fetchBenchmarkRange: async () => [] },
      clock: { now: () => 456 },
      logger: {
        ...logger,
        error: (context: Record<string, unknown>) => errorLogs.push(context),
      } as Logger,
    });

    try {
      service.startBackfill('KOSPI', '2026-01-02', '2026-01-05');
      await vi.waitFor(() => expect(service.backfillStatus().state).toBe('FAILED'));

      const failed = service.backfillStatus();
      expect(failed).toMatchObject({
        benchmarkId: 'KOSPI', state: 'FAILED', cursorDate: '2026-01-05',
        from: '2026-01-02', to: '2026-01-05',
      });
      expect(failed.error).toContain('코스피 (KOSPI) 2026-01-05');
      expect(failed.error).toContain(originalError.message);
      expect(failed.error).toContain('KRX 응답이 비어 있어 수집을 중단했습니다. 미게시로 추정한 상태이며 실제 미게시 여부는 확인되지 않았습니다. 자동으로 수집 중인 상태가 아니므로 이후 다시 동기화해 주세요.');
      expect(service.status('KOSPI', '2026-01-02', '2026-01-05')).toMatchObject({
        covered: false,
        points: [{ date: '2026-01-02', close: 3_100 }],
      });
      expect(errorLogs[0]).toMatchObject({
        benchmarkId: 'KOSPI', from: '2026-01-02', to: '2026-01-05',
        date: '2026-01-05', error: expect.stringContaining(originalError.message),
      });

      shouldBlock = false;
      service.startBackfill('KOSPI', '2026-01-05', '2026-01-05');
      await vi.waitFor(() => expect(service.backfillStatus().state).toBe('IDLE'));
      expect(fetchBenchmarkClose).toHaveBeenLastCalledWith('KOSPI', '2026-01-05');
      expect(service.status('KOSPI', '2026-01-02', '2026-01-05')).toMatchObject({
        covered: true,
        points: [
          { date: '2026-01-02', close: 3_100 },
          { date: '2026-01-05', close: 3_120 },
        ],
      });
    } finally {
      database.close();
    }
  });

  it('하루짜리 기간은 한 점만 있어도 커버하며 수익률 가용성은 결과 계층에 맡긴다', async () => {
    const database = openDatabase(':memory:');
    const service = new BenchmarkService({
      db: database.db,
      krxSource: {
        fetchIssueBaseInfo: async () => [],
        fetchDailyTrades: async () => [],
        fetchBenchmarkClose: async () => 3_100,
        todayMaxEndpointCallCount: () => 0,
      },
      fredSource: { fetchBenchmarkRange: async () => [] },
      clock: { now: () => 789 },
      logger,
    });

    try {
      expect(service.status('KOSPI', '2026-03-31', '2026-03-31').covered).toBe(false);
      await service.syncDate('KOSPI', '2026-03-31');
      expect(service.status('KOSPI', '2026-03-31', '2026-03-31')).toMatchObject({
        covered: true,
        points: [{ date: '2026-03-31', close: 3_100 }],
      });
    } finally {
      database.close();
    }
  });

  it('FRED 기간을 한 번에 수집하고 미국 거래일 커버를 확인한다', async () => {
    const database = openDatabase(':memory:');
    try {
      const fetchBenchmarkRange = vi.fn<FredBenchmarkSource['fetchBenchmarkRange']>(
        async (_benchmarkId, from, to) => from === to
          ? [{ date: from, close: 6_000 }]
          : [
              { date: '2026-01-02', close: 6_000 },
              { date: '2026-01-05', close: 6_060 },
            ],
      );
      const service = new BenchmarkService({
        db: database.db,
        krxSource: {
          fetchIssueBaseInfo: async () => [],
          fetchDailyTrades: async () => [],
          todayMaxEndpointCallCount: () => 0,
        },
        fredSource: { fetchBenchmarkRange },
        clock: { now: () => 456 },
        logger,
      });

      await service.syncDate('SP500', '2026-01-01');
      await service.syncDate('SP500', '2026-01-05');
      expect(service.status('SP500', '2026-01-01', '2026-01-05').covered).toBe(false);

      service.startBackfill('SP500', '2026-01-01', '2026-01-05');
      expect(service.backfillStatus().benchmarkId).toBe('SP500');
      await vi.waitFor(() => expect(service.backfillStatus().state).toBe('IDLE'));

      expect(fetchBenchmarkRange).toHaveBeenCalledTimes(3);
      expect(fetchBenchmarkRange).toHaveBeenLastCalledWith('SP500', '2026-01-01', '2026-01-05');
      expect(service.status('SP500', '2026-01-01', '2026-01-05')).toMatchObject({
        covered: true,
      });
    } finally {
      database.close();
    }
  });

  it('FRED 마지막 거래일 값으로 그날과 직후 주말 종료 요청을 커버한다', async () => {
    const database = openDatabase(':memory:');
    try {
      const closes = new Map([
        ['2026-08-13', 6_800],
        ['2026-08-14', 6_850],
      ]);
      const service = new BenchmarkService({
        db: database.db,
        krxSource: {
          fetchIssueBaseInfo: async () => [],
          fetchDailyTrades: async () => [],
          todayMaxEndpointCallCount: () => 0,
        },
        fredSource: {
          fetchBenchmarkRange: async (_id, from, to) => from === to && closes.has(from)
            ? [{ date: from, close: closes.get(from)! }]
            : [],
        },
        clock: { now: () => 456 },
        logger,
      });
      await service.syncDate('SP500', '2026-08-13');
      await service.syncDate('SP500', '2026-08-14');

      expect(service.status('SP500', '2026-08-13', '2026-08-14').covered).toBe(true);
      expect(service.status('SP500', '2026-08-13', '2026-08-16').covered).toBe(true);
      // 미국 시장도 확인되지 않은 다음 평일을 휴장으로 추측하지 않는다.
      expect(service.status('SP500', '2026-08-13', '2026-08-17').covered).toBe(false);
    } finally {
      database.close();
    }
  });

  it('진행 중인 백필은 다른 지수 시작 요청에도 최초 지수를 유지한다', async () => {
    const database = openDatabase(':memory:');
    let releaseKrx!: () => void;
    const krxBlocked = new Promise<void>((resolve) => { releaseKrx = resolve; });
    const fetchBenchmarkClose = vi.fn(async () => {
      await krxBlocked;
      return 100;
    });
    const fetchBenchmarkRange = vi.fn<FredBenchmarkSource['fetchBenchmarkRange']>(async () => []);
    const service = new BenchmarkService({
      db: database.db,
      krxSource: {
        fetchIssueBaseInfo: async () => [],
        fetchDailyTrades: async () => [],
        fetchBenchmarkClose,
        todayMaxEndpointCallCount: () => 0,
      },
      fredSource: { fetchBenchmarkRange },
      clock: { now: () => 789 },
      logger,
    });

    try {
      service.startBackfill('KOSPI', '2026-01-02', '2026-01-02');
      expect(service.startBackfill('SP500', '2020-01-01', '2026-01-01')).toMatchObject({
        benchmarkId: 'KOSPI',
        from: '2026-01-02',
        to: '2026-01-02',
        state: 'RUNNING',
      });
      expect(fetchBenchmarkRange).not.toHaveBeenCalled();

      releaseKrx();
      await vi.waitFor(() => expect(service.backfillStatus()).toMatchObject({
        benchmarkId: 'KOSPI',
        state: 'IDLE',
      }));
      expect(fetchBenchmarkClose).toHaveBeenCalledWith('KOSPI', '2026-01-02');
    } finally {
      releaseKrx();
      await vi.waitFor(() => expect(service.backfillStatus().state).not.toBe('RUNNING'));
      database.close();
    }
  });
});
