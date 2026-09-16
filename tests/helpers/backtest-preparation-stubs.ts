import { AsyncLocalStorage } from 'node:async_hooks';
import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { symbolMasterCoverage } from '../../src/server/shared/db/schema.js';
import type { TestApp } from './test-app.js';

export type RestorePreparationStub = () => void;

const noWorkPlan = {
  yearsBySymbol: new Map(),
  shareYearsBySymbol: new Map(),
  todayKstDate: '2026-01-01',
  calls: 0,
  estimatedMs: 0,
  overDailyLimit: false,
};

/** 외부 DART 호출만 비우고 성공한 조회 연도 coverage는 실제 저장소에 기록한다. */
export function installEmptyDartSyncStub(ctx: TestApp): RestorePreparationStub {
  const service = ctx.container.factSyncService;
  const originals = {
    planFinancialSync: service.planFinancialSync,
    planCorporateActionSync: service.planCorporateActionSync,
    sync: service.sync,
    syncCorporateActions: service.syncCorporateActions,
  };
  service.planFinancialSync = () => noWorkPlan;
  service.planCorporateActionSync = () => noWorkPlan;
  service.sync = async (request) => {
    const years = yearsBetween(request.fromYear, request.toYear);
    for (const symbol of request.symbols)
      ctx.container.factCoverageStore.addCoveredYears(symbol, years, ctx.container.clock.now());
    return emptySyncResult();
  };
  service.syncCorporateActions = async (request) => {
    const years = yearsBetween(request.fromYear, request.toYear);
    for (const symbol of request.symbols) {
      ctx.container.actionCoverageStore.addCoverageResult(
        symbol,
        years,
        [],
        ctx.container.clock.now(),
      );
    }
    return emptySyncResult();
  };
  return () => {
    service.planFinancialSync = originals.planFinancialSync;
    service.planCorporateActionSync = originals.planCorporateActionSync;
    service.sync = originals.sync;
    service.syncCorporateActions = originals.syncCorporateActions;
  };
}

/** queue 이후를 검증하는 동안에만 기존 sparse 봉 coverage 가정을 적용한다. */
export async function withSparseQueuePreparation<T>(
  ctx: TestApp,
  input: BacktestRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const periods = new AsyncLocalStorage<BacktestRequest['period']>();
  const preparation = ctx.container.backtestPreparationOrchestrator;
  const coverage = ctx.container.candleCoverageService;
  const originalRunClaimedJob = preparation.runClaimedJob;
  const originalGetReadyPreview = preparation.getReadyPreview;
  const originalGetValidDates = coverage.getValidDatesByCodeBetween;

  preparation.runClaimedJob = (jobId) => {
    const row = ctx.container.database.sqlite.prepare(
      'SELECT request_json FROM backtest_preparation_jobs WHERE id = ?',
    ).get(jobId) as { request_json: string } | undefined;
    if (row === undefined) return originalRunClaimedJob.call(preparation, jobId);
    const request = JSON.parse(row.request_json) as { period: BacktestRequest['period'] };
    return periods.run(request.period, () => originalRunClaimedJob.call(preparation, jobId));
  };
  preparation.getReadyPreview = (request) => periods.run(
    request.period,
    () => originalGetReadyPreview.call(preparation, request),
  );
  coverage.getValidDatesByCodeBetween = (codes, from, to) => {
    const scoped = periods.getStore();
    const actual = originalGetValidDates.call(
      coverage,
      codes,
      scoped?.from ?? from,
      scoped?.to ?? to,
    );
    const tradingDays = ctx.container.symbolMasterService.tradingDaysBetween(from, to);
    return new Map(codes.map((code) => [
      code,
      (actual.get(code)?.length ?? 0) > 0
        ? [...new Set([
            ...(actual.get(code) ?? []).filter((date) => date >= from && date <= to),
            ...tradingDays,
          ])].sort()
        : [],
    ]));
  };

  ctx.container.database.db.insert(symbolMasterCoverage).values({
    startDate: input.period.from,
    endDate: input.period.to,
    collectionVersion: readRuntimeVersions().collectionVersion,
    syncedAtMs: ctx.container.clock.now(),
  }).run();

  try {
    return await periods.run(input.period, operation);
  } finally {
    preparation.runClaimedJob = originalRunClaimedJob;
    preparation.getReadyPreview = originalGetReadyPreview;
    coverage.getValidDatesByCodeBetween = originalGetValidDates;
  }
}

/** preview 모양 테스트의 시장 sync와 완전 빈 봉 fixture만 명시적으로 대체한다. */
export function installPreviewShapeStubs(ctx: TestApp): RestorePreparationStub {
  const service = ctx.container.factSyncService;
  const master = ctx.container.symbolMasterService;
  const coverage = ctx.container.candleCoverageService;
  const originals = {
    planCorporateActionSync: service.planCorporateActionSync,
    syncCorporateActions: service.syncCorporateActions,
    ingestDate: master.ingestDate,
    getValidDatesByCodeBetween: coverage.getValidDatesByCodeBetween,
  };
  service.planCorporateActionSync = () => noWorkPlan;
  service.syncCorporateActions = async (request) => {
    const years = yearsBetween(request.fromYear, request.toYear);
    for (const symbol of request.symbols) {
      ctx.container.actionCoverageStore.addCoverageResult(
        symbol,
        years,
        [],
        ctx.container.clock.now(),
      );
    }
    return emptySyncResult();
  };
  master.ingestDate = async () => ({ kind: 'ALREADY_COVERED' });
  coverage.getValidDatesByCodeBetween = (codes, from, to) => {
    const actual = originals.getValidDatesByCodeBetween.call(coverage, codes, from, to);
    if ([...actual.values()].some((dates) => dates.length > 0)) return actual;
    const assumedDates = master.tradingDaysBetween(from, to);
    return new Map(codes.map((code) => [code, assumedDates.length > 0 ? assumedDates : [from]]));
  };
  return () => {
    service.planCorporateActionSync = originals.planCorporateActionSync;
    service.syncCorporateActions = originals.syncCorporateActions;
    master.ingestDate = originals.ingestDate;
    coverage.getValidDatesByCodeBetween = originals.getValidDatesByCodeBetween;
  };
}

function yearsBetween(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function emptySyncResult() {
  return {
    savedFacts: 0,
    gapCount: 0,
    gaps: [],
    stoppedAtSymbol: null,
    stopReason: null,
    failureMessage: null,
  };
}
