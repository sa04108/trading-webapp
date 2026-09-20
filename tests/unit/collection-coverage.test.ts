import { SymbolMasterService } from '../../src/runtime/modules/market-data/application/symbol-master-service.js';
import { SelectionMetricRepository } from '../../src/runtime/modules/market-data/application/selection-metric-repository.js';
import type { KrxHistoricalUniverseSource } from '../../src/runtime/modules/market-data/application/ports.js';
import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { dailySelectionMetricCoverage, facts, krxDailyBars, krxNonTradingCoverage, symbolFactsState, symbolMasterCoverage, symbolMasterTradingDays, symbols } from '../../src/runtime/shared/db/data-schema.js';
import { SqliteFactCoverageStore } from '../../src/runtime/modules/facts/application/fact-coverage-store.js';
import { SqliteCorporateActionCoverageStore } from '../../src/runtime/modules/facts/application/corporate-action-coverage.js';
import { SqliteFactRepository } from '../../src/runtime/modules/facts/infrastructure/sqlite-fact-repository.js';
import { FactSyncService } from '../../src/server/modules/facts/application/fact-sync-service.js';
import type { FactSource } from '../../src/runtime/modules/facts/application/ports.js';

const previousVersion = 'a'.repeat(64);
const currentVersion = 'b'.repeat(64);
const nowMs = Date.parse('2026-01-06T00:00:00Z');

function setup() {
  const database = openDatabase(':memory:');
  database.db.insert(symbols).values({ code: '005930', market: 'KR', createdAtMs: 1 }).run();
  database.db.insert(facts).values([2024, 2025].flatMap((year) => [
    { scope: 'SYMBOL', key: '005930', field: 'NET_INCOME', periodKey: `${year}Q1`, asOfTsMs: 1, value: 100, unit: 'KRW' },
    { scope: 'SYMBOL', key: '005930', field: 'SPLIT_RATIO', periodKey: `${year}-01-01`, asOfTsMs: 1, value: 1, unit: 'RATIO' },
  ])).run();
  const financial = new SqliteFactCoverageStore(database.db, { collectionVersion: previousVersion });
  const actions = new SqliteCorporateActionCoverageStore(database.db, { collectionVersion: previousVersion });
  financial.addCoveredYears('005930', [2024, 2025], nowMs);
  actions.addCoveredYears('005930', [2024, 2025], nowMs);
  return { database, financial, actions };
}

describe('수집 버전과 fact coverage', () => {
  it.each(['FINANCIAL', 'ACTIONS'] as const)('%s는 수집 코드가 바뀌어도 검증된 연도를 재사용한다', (kind) => {
    const { database, financial, actions } = setup();
    try {
      const historical = database.db.select().from(facts).all();
      const previous = kind === 'FINANCIAL' ? financial : actions;
      const current = kind === 'FINANCIAL'
        ? new SqliteFactCoverageStore(database.db, { collectionVersion: currentVersion })
        : new SqliteCorporateActionCoverageStore(database.db, { collectionVersion: currentVersion });
      expect(previous.getCoveredYears().get('005930')).toEqual([2024, 2025]);
      expect(current.getCoveredYears().get('005930')).toEqual([2024, 2025]);
      expect(current.getCollectedYears().get('005930')).toEqual([2024, 2025]);
      expect(database.db.select().from(facts).all()).toEqual(historical);
      current.addCoveredYears('005930', [2025], nowMs);
      expect(current.getCoveredYears().get('005930')).toEqual([2024, 2025]);
      expect(current.getCollectedYears().get('005930')).toEqual([2024, 2025]);
      expect(database.db.select().from(facts).all()).toEqual(historical);
    } finally { database.close(); }
  });

  it('protocol 형식 번호가 같아도 수집 버전이 없는 과거 coverage도 재사용한다', () => {
    const { database, financial, actions } = setup();
    try {
      const row = database.db.select().from(symbolFactsState).get()!;
      const financialProtocol = JSON.parse(row.financialCoverageProtocolJson!) as Record<string, unknown>;
      const actionProtocol = JSON.parse(row.actionCoverageProtocolJson!) as Record<string, unknown>;
      delete financialProtocol.collectionVersion;
      delete actionProtocol.collectionVersion;
      database.db.update(symbolFactsState).set({
        financialCoverageProtocolJson: JSON.stringify(financialProtocol),
        actionCoverageProtocolJson: JSON.stringify(actionProtocol),
      }).run();
      expect(financial.getCoveredYears().get('005930')).toEqual([2024, 2025]);
      expect(actions.getCoveredYears().get('005930')).toEqual([2024, 2025]);
    } finally { database.close(); }
  });

  it.each(['FINANCIAL', 'ACTIONS'] as const)('%s 증분 수집은 실행 버전만 바뀐 데이터를 다시 요청하지 않는다', async (kind) => {
    const { database } = setup();
    try {
      const financial = new SqliteFactCoverageStore(database.db, { collectionVersion: currentVersion });
      const actions = new SqliteCorporateActionCoverageStore(database.db, { collectionVersion: currentVersion });
      const source: FactSource = {
        fetchFinancials: vi.fn(async () => ({ facts: [{ scope: 'SYMBOL' as const, key: '005930', field: 'NET_INCOME', periodKey: '2025Q1', asOfTsMs: 1, value: 200, unit: 'KRW' }], gaps: [] })),
        fetchCorporateActions: vi.fn(async () => ({ facts: [{ scope: 'SYMBOL' as const, key: '005930', field: 'SPLIT_RATIO', periodKey: '2025-01-01', asOfTsMs: 1, value: 2, unit: 'RATIO' }], gaps: [] })),
        listRecentPeriodicFilings: async () => [],
      };
      const service = new FactSyncService(source, new SqliteFactRepository(database.db), pino({ enabled: false }), { bumpVersion() {} }, { now: () => nowMs }, financial, actions);
      const request = { symbols: ['005930'], fromYear: 2025, toYear: 2025, mode: 'INCREMENTAL' as const, consolidated: true };
      const report = kind === 'FINANCIAL' ? await service.sync(request) : await service.syncCorporateActions(request);
      expect(report.stopReason).toBeNull();
      expect(source.fetchCorporateActions).not.toHaveBeenCalled();
      if (kind === 'FINANCIAL') expect(source.fetchFinancials).not.toHaveBeenCalled();
      expect((kind === 'FINANCIAL' ? financial : actions).getCoveredYears().get('005930')).toEqual([2024, 2025]);
      const rows = database.db.select().from(facts).all();
      expect(rows.find((row) => row.periodKey === '2024Q1')?.value).toBe(100);
      expect(rows.find((row) => row.periodKey === '2024-01-01')?.value).toBe(1);
      expect(rows.find((row) => row.periodKey === '2025-01-01')?.value).toBe(1);
      if (kind === 'FINANCIAL') expect(rows.find((row) => row.periodKey === '2025Q1')?.value).toBe(100);
    } finally { database.close(); }
  });
});

function setupMarket() {
  const database = openDatabase(':memory:');
  const source: KrxHistoricalUniverseSource = {
    fetchDailyTrades: vi.fn(async (market) => market === 'KOSPI' ? [{
      shortCode: '005930', name: '삼성전자', marketCapRaw: '100000', tradingValueRaw: '1000',
      open: 100, high: 110, low: 90, close: 105, volume: 10,
    }] : []),
    fetchIssueBaseInfo: vi.fn(async (market) => market === 'KOSPI' ? [{
      standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', listedDate: '1975-06-11',
      marketRaw: 'KOSPI', securityGroupRaw: '주권', sectionRaw: null, stockKindRaw: '보통주', listedShares: '1000',
    }] : []),
    todayMaxEndpointCallCount: () => 0,
  };
  const service = (collectionVersion: string) => new SymbolMasterService({
    db: database.db, source, collectionVersion, clock: { now: () => nowMs }, logger: pino({ enabled: false }),
  });
  return { database, source, service };
}

describe('수집 버전과 KRX coverage', () => {
  it.each([previousVersion, null])('이전 수집 표식 %s와 값을 외부 요청 없이 보존한다', async (storedVersion) => {
    const { database, source, service } = setupMarket();
    try {
      await service(previousVersion).ingestDate('2026-01-05');
      await service(previousVersion).ingestDate('2026-01-06');
      database.db.update(symbolMasterCoverage).set({ collectionVersion: storedVersion }).run();
      database.db.update(krxNonTradingCoverage).set({ collectionVersion: storedVersion }).run();
      database.db.update(dailySelectionMetricCoverage).set({ collectionVersion: storedVersion }).run();
      const historical = database.db.select().from(krxDailyBars).all();
      const coverage = database.db.select().from(symbolMasterCoverage).all();
      vi.mocked(source.fetchDailyTrades).mockClear();
      vi.mocked(source.fetchIssueBaseInfo).mockClear();
      const current = service(currentVersion);
      expect(current.isCovered('2026-01-06')).toBe(true);
      expect(current.isRangeCovered('2026-01-05', '2026-01-06')).toBe(true);
      expect(current.effectiveTradingDateWithinCoverage('2026-01-06')).toBe('2026-01-06');
      expect(current.isNonTradingRangeCovered('2026-01-05', '2026-01-06')).toBe(true);
      expect(await current.ensureTradingDay('2026-01-06')).toMatchObject({
        effectiveTradingDate: '2026-01-06', ingestedDates: [],
      });
      expect(await current.ingestDate('2026-01-06')).toEqual({ kind: 'ALREADY_COVERED' });
      await current.ensureSelectionMetrics(['2026-01-05', '2026-01-06']);
      expect(await current.backfillNonTradingDays('2026-01-05', '2026-01-06')).toEqual({ dates: 0, rows: 0 });
      expect(source.fetchDailyTrades).not.toHaveBeenCalled();
      expect(source.fetchIssueBaseInfo).not.toHaveBeenCalled();
      expect(database.db.select().from(krxDailyBars).all()).toEqual(historical);
      expect(database.db.select().from(symbolMasterCoverage).all()).toEqual(coverage);
    } finally { database.close(); }
  });

  it('NULL·서로 다른 실행 버전의 중첩 구간을 합치고 실제 하루 결손은 유지한다', async () => {
    const { database, service } = setupMarket();
    try {
      const ranges = [
        { startDate: '2026-01-01', endDate: '2026-01-05', collectionVersion: null, syncedAtMs: 1 },
        { startDate: '2026-01-03', endDate: '2026-01-06', collectionVersion: previousVersion, syncedAtMs: 2 },
        { startDate: '2026-01-06', endDate: '2026-01-07', collectionVersion: currentVersion, syncedAtMs: 3 },
        { startDate: '2026-01-09', endDate: '2026-01-09', collectionVersion: null, syncedAtMs: 4 },
      ];
      database.db.insert(symbolMasterCoverage).values(ranges).run();
      database.db.insert(krxNonTradingCoverage).values(ranges).run();
      database.db.insert(symbolMasterTradingDays).values({ date: '2026-01-02' }).run();
      const current = service(currentVersion);
      expect(current.effectiveTradingDateWithinCoverage('2026-01-07')).toBe('2026-01-02');
      expect(current.effectiveTradingDateWithinCoverage('2026-01-09')).toBeUndefined();
      expect(current.coverageRanges()).toEqual([
        { startDate: '2026-01-01', endDate: '2026-01-07', syncedAtMs: 3 },
        { startDate: '2026-01-09', endDate: '2026-01-09', syncedAtMs: 4 },
      ]);
      expect(current.isRangeCovered('2026-01-01', '2026-01-07')).toBe(true);
      expect(current.isNonTradingRangeCovered('2026-01-01', '2026-01-07')).toBe(true);
      expect(current.isRangeCovered('2026-01-01', '2026-01-09')).toBe(false);
      expect(current.isNonTradingRangeCovered('2026-01-01', '2026-01-09')).toBe(false);
      await current.ingestDate('2026-01-08');
      expect(current.coverageRanges()).toEqual([
        { startDate: '2026-01-01', endDate: '2026-01-09', syncedAtMs: nowMs },
      ]);
      expect(current.isNonTradingRangeCovered('2026-01-01', '2026-01-09')).toBe(true);
    } finally { database.close(); }
  });

  it.each([previousVersion, null])('선정 지표의 이전 표식 %s는 값을 다시 조회하지 않는다', async (storedVersion) => {
    const { database, source, service } = setupMarket();
    try {
      const current = service(currentVersion);
      await current.ingestDate('2026-01-05');
      database.db.update(dailySelectionMetricCoverage).set({ collectionVersion: storedVersion }).run();
      const metrics = new SelectionMetricRepository(database.db, { collectionVersion: currentVersion });
      expect(metrics.findMissingTradingValueDates(['2026-01-05'])).toEqual([]);
      vi.mocked(source.fetchDailyTrades).mockClear();
      await current.ensureSelectionMetrics(['2026-01-05']);
      expect(source.fetchDailyTrades).not.toHaveBeenCalled();
      expect(metrics.findMissingTradingValueDates(['2026-01-05'])).toEqual([]);
      await current.ensureSelectionMetrics(['2026-01-05']);
      expect(source.fetchDailyTrades).not.toHaveBeenCalled();
    } finally { database.close(); }
  });
});
