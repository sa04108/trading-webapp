import { describe, expect, vi } from 'vitest';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { createSubmissionValidator } from '../../src/server/modules/backtest/application/submission-validation.js';
import type { BacktestUniversePreview } from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';
import type { TestApp } from '../helpers/test-app.js';
import { test as base } from '../helpers/test-fixtures.js';
import { registerSymbols, seedDailyBars } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

const ts = (date: string): number => Date.parse(`${date}T00:00:00Z`);

function request(strategyId = 'range-breakout'): BacktestRequest {
  return {
    strategyId,
    parameters: strategyId === 'cross-sectional-momentum'
      ? { formationDays: 20, skipDays: 0, topN: 1, absoluteMomentumFilter: true }
      : { lookbackBars: 2, atrPeriod: 2, stopAtrMultiplier: 2, trailAtrMultiplier: 2, riskPerTradePercent: 1, maxPositionWeightPercent: 20 },
    universeRule: {
      markets: ['KOSPI'],
      stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
      rebalanceInterval: { unit: 'DAY', value: 1 },
    },
    period: { from: '2026-01-05', to: '2026-01-06' },
    capital: { initialCash: 10_000_000, currency: 'KRW' },
    execution: {
      fillTiming: 'NEXT_BAR_OPEN',
      commissionProfileId: 'kr-equity-default',
      slippageProfileId: 'fixed-5bps',
    },
    risk: { maxPositions: 1 },
    randomSeed: 42,
  };
}

function preview(rebalanceDates: readonly string[]): BacktestUniversePreview {
  return {
    preparationJobId: 'prep-test',
    schedule: rebalanceDates.map((date) => ({
      rebalanceDate: date,
      effectiveDate: date,
      fromTsMs: ts(date),
      members: [{
        symbol: '005930', standardCode: 'KR7005930003', marketCapKrw: '500000000000000',
        volume: 1_000, tradingValueKrw: '1000000000',
      }],
      excludedNonTradingCount: 0,
    })),
    diagnostics: [],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
    unionSymbols: ['005930'],
    scheduleHash: 'prepared-hash',
    uncoveredDates: [],
    periodCovered: true,
    missingCandleSymbols: [],
    warnings: [],
  };
}

function validator(container: TestApp['container']) {
  return createSubmissionValidator({
    database: container.database,
    strategies: container.strategyRegistry,
    symbolService: container.symbolService,
    symbolMaster: container.symbolMasterService,
    candleCoverage: container.candleCoverageService,
    factCoverage: container.factCoverageStore,
    financialFacts: container.financialFactAvailabilityService,
    facts: container.factRepository,
    clock: container.clock,
  });
}

const it = base.extend<{ prepared: TestApp['container'] }>({
  prepared: async ({ ctx }, use) => {
    const container = ctx.container;
    seedSymbolMasterUniverse(container, ['2026-01-05', '2026-01-06'], [{
      standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자',
      market: 'KOSPI', marketCapKrw: '500000000000000',
    }]);
    registerSymbols(container, 'KR', ['005930']);
    seedDailyBars(container.database.db, ['2026-01-05', '2026-01-06'].map((date) => ({
      symbol: '005930', market: 'KR' as const, timeframe: '1d' as const, tsMs: ts(date),
      open: 100, high: 110, low: 90, close: 105, volume: 1_000,
    })));
    await use(container);
  },
});

describe('createSubmissionValidator', () => {
  it('gap 0 전략은 coverage를 요청 안에서 공유하고 타임라인을 읽지 않는다', async ({ prepared }) => {
    const coverage = prepared.candleCoverageService;
    const getCoverage = vi.spyOn(coverage, 'getCoverage');
    const getCoverageBetween = vi.spyOn(coverage, 'getCoverageBetween');
    const getTimeline = vi.spyOn(coverage, 'getTimeline');

    const result = await validator(prepared).validate(request(), preview(['2026-01-05']));

    expect(result).toMatchObject({ ok: true, estimatedBars: 2 });
    expect(getCoverage).toHaveBeenCalledTimes(1);
    expect(getCoverageBetween).toHaveBeenCalledTimes(1);
    expect(getTimeline).not.toHaveBeenCalled();
  });

  it('검증 호출과 dataset revision 사이에는 coverage 캐시를 재사용하지 않는다', async ({ prepared }) => {
    const coverage = prepared.candleCoverageService;
    const getCoverage = vi.spyOn(coverage, 'getCoverage');
    const validate = validator(prepared).validate;

    const first = await validate(request(), preview(['2026-01-05']));
    prepared.database.sqlite.prepare(
      'UPDATE data.dataset_state SET revision = revision + 1 WHERE singleton = 1',
    ).run();
    const second = await validate(request(), preview(['2026-01-05']));

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) throw new Error('검증 결과가 성공이어야 합니다');
    expect(second.snapshot.revision).toBe(first.snapshot.revision + 1);
    expect(getCoverage).toHaveBeenCalledTimes(2);
  });

  it('gap 전략은 실제 타임라인을 읽고 연속 리밸런스를 거부한다', async ({ prepared }) => {
    const coverage = prepared.candleCoverageService;
    const getTimeline = vi.spyOn(coverage, 'getTimeline');

    const result = await validator(prepared).validate(
      request('cross-sectional-momentum'),
      preview(['2026-01-05', '2026-01-06']),
    );

    expect(getTimeline).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: 422 });
    if (result.ok) throw new Error('리밸런스 간격 위반이어야 합니다');
    expect(result.errors[0]).toContain('리밸런스');
  });
});
