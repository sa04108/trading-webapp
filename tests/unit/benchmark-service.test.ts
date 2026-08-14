import { describe, expect, it } from 'vitest';
import { BenchmarkService } from '../../src/server/modules/market-data/application/benchmark-service.js';
import type { KrxHistoricalUniverseSource } from '../../src/server/modules/market-data/application/ports.js';
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
      const source: KrxHistoricalUniverseSource = {
        fetchIssueBaseInfo: async () => [],
        fetchDailyTrades: async () => [],
        fetchBenchmarkClose: async (id, date) => closes.get(`${id}:${date}`) ?? null,
        todayMaxEndpointCallCount: () => 0,
      };
      const service = new BenchmarkService({
        db: database.db,
        source,
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
      await service.syncDate('2026-01-02');
      await service.syncDate('2026-01-05');

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
    } finally {
      database.close();
    }
  });
});
