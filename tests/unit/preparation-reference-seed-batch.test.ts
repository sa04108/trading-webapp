import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../../src/shared/schemas/provenance-pin.js';
import type { BenchmarkPin } from '../../src/shared/schemas/benchmark.js';
import { SeedCloneBatchService, type SeedCloneBatchSnapshot } from '../../src/server/modules/backtest/application/seed-clone-batch-service.js';
import type { LegacyUniverseScheduleEntry } from '../../src/server/modules/backtest/application/universe-rule-resolver.js';

const request: BacktestRequest = {
  strategyId: 'range-breakout',
  parameters: {},
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
    rebalanceInterval: { unit: 'DAY', value: 1 },
  },
  period: { from: '2026-01-05', to: '2026-01-05' },
  capital: { initialCash: 1_000_000, currency: 'KRW' },
  execution: {
    fillTiming: 'NEXT_BAR_OPEN',
    commissionProfileId: 'kr-equity-default',
    slippageProfileId: 'fixed-5bps',
  },
  risk: { maxPositions: 1 },
  randomSeed: 42,
};

describe('seed clone preparation ownership', () => {
  let ctx: TestApp;
  let seedBatchService: SeedCloneBatchService;

  beforeEach(async () => {
    ctx = await createTestApp();
    seedBatchService = new SeedCloneBatchService(
      ctx.container.database, ctx.container.jobQueue, 20, ctx.container.clock, () => {},
    );
  });

  afterEach(async () => {
    await ctx.close();
  });

  function seedPreparation(id: string): void {
    ctx.container.database.sqlite.prepare(`
      INSERT INTO backtest_preparation_jobs
        (id, request_hash, request_json, status, phase, lifecycle_managed,
         preview_json, created_at_ms, updated_at_ms, completed_at_ms)
      VALUES (?, 'seed-hash', ?, 'COMPLETED', 'FINALIZING', 1, ?, 1, 1, 1)
    `).run(id, JSON.stringify({
      universeRule: request.universeRule,
      period: request.period,
      strategyId: request.strategyId,
      parameters: request.parameters,
    }), JSON.stringify({
      schedule: [], unionSymbols: [], warnings: [], scheduleHash: 'seed-schedule',
      uncoveredDates: [], periodCovered: true, missingCandleSymbols: [],
    }));
    ctx.container.database.sqlite.prepare(`
      INSERT INTO preparation_preview_cache
        (job_id, data_revision, validation_version, fundamental_symbols_json)
      VALUES (?, 1, 'seed-test', '[]')
    `).run(id);
  }

  function snapshot(preparationJobId: string): SeedCloneBatchSnapshot {
    const schedule: LegacyUniverseScheduleEntry[] = [{
      rebalanceDate: '2026-01-05',
      effectiveTradingDate: '2026-01-05',
      symbols: ['005930'],
      members: [{
        symbol: '005930', standardCode: 'KR7005930003', marketCapKrw: '1',
        volume: null, tradingValueKrw: null,
      }],
      excludedNonTradingCount: 0,
    }];
    const provenancePin: ProvenancePin = {
      sourceKind: 'SYMBOL_MASTER', filterPolicyVersion: null,
      selectionMethod: 'TEST', scheduleHash: 'seed-schedule',
    };
    const benchmark: BenchmarkPin = {
      benchmarkId: 'KOSPI', name: '코스피', source: 'KRX_OPEN_API', sourceVersion: 'v1',
      period: { from: '2026-01-05', to: '2026-01-05' }, points: [], covered: false,
    };
    return {
      preparationJobId, request, schedule,
      universe: { entries: [], hash: 'universe-hash' },
      provenancePin, benchmark: { pin: benchmark, hash: 'benchmark-hash' }, warnings: [],
    };
  }

  it('대기 batch와 생성 child가 준비 ID를 보존하고 source 삭제 뒤 마지막 소유자 삭제로 준비와 cache를 수집한다', () => {
    seedPreparation('prep_seed_batch');
    const source = ctx.container.jobQueue.enqueue(request, [], undefined, null, [], undefined, {
      preparationJobId: 'prep_seed_batch',
    });
    const batch = seedBatchService.create(source.id, 2, snapshot('prep_seed_batch'));

    expect(batch.batch.preparationJobId).toBe('prep_seed_batch');
    expect(batch.items.every(({ job }) => job?.preparationJobId === 'prep_seed_batch')).toBe(true);

    for (const { job } of batch.items) {
      expect(job).not.toBeNull();
      expect(ctx.container.jobQueue.setStatus(job!.id, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    }
    ctx.container.database.sqlite.prepare(
      "UPDATE backtest_clone_batches SET status = 'COMPLETED', completed_at_ms = 2 WHERE id = ?",
    ).run(batch.batch.id);

    expect(seedBatchService.delete(batch.batch.id)).toBe('DELETED');
    expect(ctx.container.jobQueue.getJob(source.id)).not.toBeNull();
    expect(ctx.container.jobQueue.setStatus(source.id, 'COMPLETED', {}, ['QUEUED'])).toBe(true);
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep_seed_batch')).toEqual({ id: 'prep_seed_batch' });

    expect(seedBatchService.deleteSourceJob(source.id)).toBe('DELETED');
    expect(ctx.container.database.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep_seed_batch')).toBeUndefined();
    expect(ctx.container.database.sqlite.prepare(
      'SELECT job_id FROM preparation_preview_cache WHERE job_id = ?',
    ).get('prep_seed_batch')).toBeUndefined();
  });

  it('원본의 준비 ID가 없으면 batch 생성이 실패하고 batch와 child를 만들지 않는다', () => {
    const source = ctx.container.jobQueue.enqueue(request);
    expect(() => seedBatchService.create(source.id, 2, snapshot('missing-preparation')))
      .toThrow();
    expect(seedBatchService.list()).toEqual([]);
    expect(ctx.container.jobQueue.listJobs(100, 0)).toHaveLength(1);
  });
});
