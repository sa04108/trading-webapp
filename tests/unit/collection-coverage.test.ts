import { SymbolMasterService } from '../../src/runtime/modules/market-data/application/symbol-master-service.js';
import { SelectionMetricRepository } from '../../src/runtime/modules/market-data/application/selection-metric-repository.js';
import type { KrxHistoricalUniverseSource } from '../../src/runtime/modules/market-data/application/ports.js';
import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { dailySelectionMetricCoverage, facts, krxDailyBars, krxNonTradingCoverage, symbolFactsState, symbolMasterCoverage, symbols } from '../../src/runtime/shared/db/data-schema.js';
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
  it.each(['FINANCIAL', 'ACTIONS'] as const)('%s는 수집 코드가 바뀌면 재수집한 연도만 다시 검증한다', (kind) => {
    const { database, financial, actions } = setup();
    try {
      const historical = database.db.select().from(facts).all();
      const previous = kind === 'FINANCIAL' ? financial : actions;
      const current = kind === 'FINANCIAL'
        ? new SqliteFactCoverageStore(database.db, { collectionVersion: currentVersion })
        : new SqliteCorporateActionCoverageStore(database.db, { collectionVersion: currentVersion });
      expect(previous.getCoveredYears().get('005930')).toEqual([2024, 2025]);
      expect(current.getCoveredYears().get('005930')).toEqual([]);
      expect(current.getCollectedYears().get('005930')).toEqual([2024, 2025]);
      expect(database.db.select().from(facts).all()).toEqual(historical);
      current.addCoveredYears('005930', [2025], nowMs);
      expect(current.getCoveredYears().get('005930')).toEqual([2025]);
      expect(current.getCollectedYears().get('005930')).toEqual([2024, 2025]);
      expect(database.db.select().from(facts).all()).toEqual(historical);
    } finally { database.close(); }
  });

  it('protocol 형식 번호가 같아도 수집 버전이 없는 과거 coverage는 거절한다', () => {
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
      expect(financial.getCoveredYears().get('005930')).toEqual([]);
      expect(actions.getCoveredYears().get('005930')).toEqual([]);
    } finally { database.close(); }
  });

  it.each(['FINANCIAL', 'ACTIONS'] as const)('%s 증분 수집이 이전 parser 결과를 건너뛰지 않고 기존 저장 경로로 갱신한다', async (kind) => {
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
      expect(source.fetchCorporateActions).toHaveBeenCalledTimes(1);
      if (kind === 'FINANCIAL') expect(source.fetchFinancials).toHaveBeenCalledTimes(1);
      expect((kind === 'FINANCIAL' ? financial : actions).getCoveredYears().get('005930')).toEqual([2025]);
      const rows = database.db.select().from(facts).all();
      expect(rows.find((row) => row.periodKey === '2024Q1')?.value).toBe(100);
      expect(rows.find((row) => row.periodKey === '2024-01-01')?.value).toBe(1);
      expect(rows.find((row) => row.periodKey === '2025-01-01')?.value).toBe(2);
      if (kind === 'FINANCIAL') expect(rows.find((row) => row.periodKey === '2025Q1')?.value).toBe(200);
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
  it.each([previousVersion, null])('이전 수집 표식 %s는 요청한 날짜만 재검증하고 기존 기간 데이터를 보존한다', async (storedVersion) => {
    const { database, source, service } = setupMarket();
    try {
      const previous = service(previousVersion);
      await previous.ingestDate('2026-01-05');
      await previous.ingestDate('2026-01-06');
      database.db.update(symbolMasterCoverage).set({ collectionVersion: storedVersion }).run();
      database.db.update(krxNonTradingCoverage).set({ collectionVersion: storedVersion }).run();
      database.db.update(dailySelectionMetricCoverage).set({ collectionVersion: storedVersion }).run();
      const historical = database.db.select().from(krxDailyBars).all();
      const current = service(currentVersion);
      expect(current.isCovered('2026-01-06')).toBe(false);
      expect(current.isRangeCovered('2026-01-05', '2026-01-06')).toBe(false);
      expect(current.effectiveTradingDateWithinCoverage('2026-01-06')).toBeUndefined();
      expect(current.isNonTradingRangeCovered('2026-01-05', '2026-01-06')).toBe(false);
      expect(database.db.select().from(krxDailyBars).all()).toEqual(historical);
      vi.mocked(source.fetchDailyTrades).mockImplementation(async (market) => market === 'KOSPI' ? [{
        shortCode: '005930', name: '삼성전자', marketCapRaw: '101000', tradingValueRaw: '1010',
        open: 100, high: 110, low: 90, close: 106, volume: 11,
      }] : []);
      expect(await current.ensureTradingDay('2026-01-06')).toMatchObject({
        effectiveTradingDate: '2026-01-06', ingestedDates: ['2026-01-06'],
      });
      expect(current.isRangeCovered('2026-01-06', '2026-01-06')).toBe(true);
      expect(current.isRangeCovered('2026-01-05', '2026-01-06')).toBe(false);
      expect(current.isNonTradingRangeCovered('2026-01-06', '2026-01-06')).toBe(true);
      expect(current.isNonTradingRangeCovered('2026-01-05', '2026-01-06')).toBe(false);
      expect(database.db.select().from(krxDailyBars).all().find((row) => row.date === '2026-01-05')).toEqual(historical.find((row) => row.date === '2026-01-05'));
      expect(database.db.select().from(krxDailyBars).all().find((row) => row.date === '2026-01-06')?.close).toBe(106);
      vi.mocked(source.fetchDailyTrades).mockClear();
      expect(await current.ingestDate('2026-01-06')).toEqual({ kind: 'ALREADY_COVERED' });
      expect(source.fetchDailyTrades).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it.each([previousVersion, null])('선정 지표의 이전 표식 %s는 값이 있어도 다시 조회한다', async (storedVersion) => {
    const { database, source, service } = setupMarket();
    try {
      const current = service(currentVersion);
      await current.ingestDate('2026-01-05');
      database.db.update(dailySelectionMetricCoverage).set({ collectionVersion: storedVersion }).run();
      const metrics = new SelectionMetricRepository(database.db, { collectionVersion: currentVersion });
      expect(metrics.findMissingTradingValueDates(['2026-01-05'])).toEqual(['2026-01-05']);
      vi.mocked(source.fetchDailyTrades).mockClear();
      await current.ensureSelectionMetrics(['2026-01-05']);
      expect(source.fetchDailyTrades).toHaveBeenCalledTimes(2);
      expect(metrics.findMissingTradingValueDates(['2026-01-05'])).toEqual([]);
      await current.ensureSelectionMetrics(['2026-01-05']);
      expect(source.fetchDailyTrades).toHaveBeenCalledTimes(2);
    } finally { database.close(); }
  });
});
