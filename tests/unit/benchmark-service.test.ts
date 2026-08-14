import { describe, expect, it, vi } from 'vitest';
import { BenchmarkService } from '../../src/server/modules/market-data/application/benchmark-service.js';
import type {
  FredBenchmarkSource,
  KrxHistoricalUniverseSource,
} from '../../src/server/modules/market-data/application/ports.js';
import { ResultsService } from '../../src/server/modules/backtest/application/results-service.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import {
  backtestJobs,
  backtestMetrics,
  symbolMasterCoverage,
  symbolMasterTradingDays,
} from '../../src/server/shared/db/schema.js';
import type { Logger } from '../../src/server/shared/logger.js';

const logger = {
  debug() {}, info() {}, warn() {}, error() {},
} as unknown as Logger;

describe('벤치마크 저장과 결과 비교', () => {
  it('거래일 커버를 pin하고 전략 대비 단순 초과수익률을 계산한다', async () => {
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
        syncedAtMs: 1,
      }).run();
      await service.syncDate('KOSPI', '2026-01-02');
      await service.syncDate('KOSPI', '2026-01-05');

      const benchmark = service.pin('KOSPI', { from: '2026-01-02', to: '2026-01-05' });
      expect(benchmark.pin).toMatchObject({ covered: true, missingTradingDays: 0 });
      expect(benchmark.hash).toMatch(/^[a-f0-9]{64}$/);

      database.db.insert(backtestJobs).values({
        id: 'bt_benchmark',
        status: 'COMPLETED',
        requestJson: JSON.stringify({ benchmarkId: 'KOSPI' }),
        strategyId: 'test',
        universeRuleJson: '{}',
        universeScheduleJson: '[]',
        benchmarkJson: JSON.stringify(benchmark.pin),
        benchmarkHash: benchmark.hash,
        createdAtMs: 1,
      }).run();
      database.db.insert(backtestMetrics).values({
        jobId: 'bt_benchmark',
        totalReturnPct: 15,
        cagrPct: null,
        maxDrawdownPct: -2,
        sharpe: null,
        winRate: null,
        tradeCount: 0,
        metricsJson: JSON.stringify({ totalReturnPct: 15 }),
      }).run();

      const results = new ResultsService(database.db);
      const summary = results.getBenchmark('bt_benchmark');
      expect(summary).toMatchObject({
        available: true,
        dataHash: benchmark.hash,
      });
      expect(summary?.totalReturnPct).toBeCloseTo(10);
      expect(summary?.excessReturnPct).toBeCloseTo(5);
      const chart = results.getChartSeries('bt_benchmark').benchmark;
      expect(chart.map((point) => point.tsMs)).toEqual([
        Date.parse('2026-01-02T00:00:00Z'),
        Date.parse('2026-01-05T00:00:00Z'),
      ]);
      expect(chart[0]?.value).toBe(100);
      expect(chart[1]?.value).toBeCloseTo(110);

      fetchBenchmarkClose.mockClear();
      service.startBackfill('KOSPI', '2026-01-02', '2026-01-06');
      await vi.waitFor(() => expect(service.backfillStatus().state).toBe('IDLE'));
      expect(fetchBenchmarkClose).toHaveBeenCalledOnce();
      expect(fetchBenchmarkClose).toHaveBeenCalledWith('KOSPI', '2026-01-06');
    } finally {
      database.close();
    }
  });

  it('FRED 기간을 한 번에 수집하고 미국 거래일로 pin한다', async () => {
    const database = openDatabase(':memory:');
    try {
      const fetchBenchmarkRange = vi.fn<FredBenchmarkSource['fetchBenchmarkRange']>(async () => [
        { date: '2026-01-02', close: 6_000 },
        { date: '2026-01-05', close: 6_060 },
      ]);
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

      service.startBackfill('SP500', '2026-01-01', '2026-01-05');
      expect(service.backfillStatus().benchmarkId).toBe('SP500');
      await vi.waitFor(() => expect(service.backfillStatus().state).toBe('IDLE'));

      expect(fetchBenchmarkRange).toHaveBeenCalledOnce();
      expect(fetchBenchmarkRange).toHaveBeenCalledWith('SP500', '2026-01-01', '2026-01-05');
      expect(service.pin('SP500', { from: '2026-01-01', to: '2026-01-05' }).pin).toMatchObject({
        name: 'S&P 500',
        source: 'FRED_API',
        covered: true,
        missingTradingDays: 0,
      });
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
