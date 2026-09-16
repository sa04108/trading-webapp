import { SymbolMasterService } from '../../src/runtime/modules/market-data/application/symbol-master-service.js';
import { SelectionMetricRepository } from '../../src/runtime/modules/market-data/application/selection-metric-repository.js';
import type { KrxHistoricalUniverseSource } from '../../src/runtime/modules/market-data/application/ports.js';
import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { and, eq } from 'drizzle-orm';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { dailySelectionMetricCoverage, dailySelectionMetrics, facts, krxDailyBars, krxNonTradingCoverage, symbolFactsState, symbolMasterCoverage, symbolMasterTradingDays, symbols } from '../../src/runtime/shared/db/data-schema.js';
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

describe('B: 실행 버전과 독립적인 DART coverage', () => {
  it.each(['FINANCIAL', 'ACTIONS'] as const)('%s 실행 해시 변경은 과거 완료 연도와 fact를 무효화하지 않는다', (kind) => {
    const { database, financial, actions } = setup();
    try {
      const historical = database.db.select().from(facts).all();
      const originalState = database.db.select().from(symbolFactsState).all();
      const previous = kind === 'FINANCIAL' ? financial : actions;
      const current = kind === 'FINANCIAL'
        ? new SqliteFactCoverageStore(database.db, { collectionVersion: currentVersion })
        : new SqliteCorporateActionCoverageStore(database.db, { collectionVersion: currentVersion });
      expect(previous.getCoveredYears().get('005930')).toEqual([2024, 2025]);
      expect(current.getCoveredYears().get('005930')).toEqual([2024, 2025]);
      expect(current.getCollectedYears().get('005930')).toEqual([2024, 2025]);
      expect(database.db.select().from(symbolFactsState).all()).toEqual(originalState);
      current.addCoveredYears('005930', [2025], nowMs);
      expect(current.getCoveredYears().get('005930')).toEqual([2024, 2025]);
      expect(database.db.select().from(facts).all()).toEqual(historical);
    } finally { database.close(); }
  });

  it.each([undefined, null])('실행 버전 %s인 과거 protocol도 내용과 해석 protocol이 유효하면 재사용한다', (version) => {
    const { database, financial, actions } = setup();
    try {
      const row = database.db.select().from(symbolFactsState).get()!;
      const financialProtocol = JSON.parse(row.financialCoverageProtocolJson!) as Record<string, unknown>;
      const actionProtocol = JSON.parse(row.actionCoverageProtocolJson!) as Record<string, unknown>;
      if (version === undefined) {
        delete financialProtocol.collectionVersion;
        delete actionProtocol.collectionVersion;
      } else {
        financialProtocol.collectionVersion = version;
        actionProtocol.collectionVersion = version;
      }
      database.db.update(symbolFactsState).set({
        financialCoverageProtocolJson: JSON.stringify(financialProtocol),
        actionCoverageProtocolJson: JSON.stringify(actionProtocol),
      }).run();
      expect(financial.getCoveredYears().get('005930')).toEqual([2024, 2025]);
      expect(actions.getCoveredYears().get('005930')).toEqual([2024, 2025]);
    } finally { database.close(); }
  });

  it('실행 해시를 분리해도 실제 fact 변조와 blocking gap은 숨기지 않는다', () => {
    const { database, financial, actions } = setup();
    try {
      financial.addCoverageResult('005930', [2025], [{ symbol: '005930', periodKey: '2025Q1', severity: 'BLOCKING', reason: '원문 필드 누락' }], nowMs);
      actions.addGapYears('005930', [2025], nowMs);
      const current = new SqliteFactCoverageStore(database.db, { collectionVersion: currentVersion });
      expect(current.getCoverageState().get('005930')?.blockingGapYears).toEqual([2025]);
      expect(new SqliteCorporateActionCoverageStore(database.db, { collectionVersion: currentVersion }).getGapYears().get('005930')).toEqual([2025]);
      database.db.update(facts).set({ value: 999 }).where(and(eq(facts.field, 'NET_INCOME'), eq(facts.periodKey, '2025Q1'))).run();
      expect(current.getCoveredYears().get('005930')).toEqual([2024]);
      expect(current.getCollectedYears().get('005930')).toEqual([2024, 2025]);
    } finally { database.close(); }
  });

  it('해석 protocol 불일치는 실행 해시 변경과 달리 계속 검출한다', () => {
    const { database, financial, actions } = setup();
    try {
      const row = database.db.select().from(symbolFactsState).get()!;
      const f = JSON.parse(row.financialCoverageProtocolJson!);
      const a = JSON.parse(row.actionCoverageProtocolJson!);
      database.db.update(symbolFactsState).set({
        financialCoverageProtocolJson: JSON.stringify({ ...f, version: f.version + 1 }),
        actionCoverageProtocolJson: JSON.stringify({ ...a, version: a.version + 1 }),
      }).run();
      expect(financial.getCoveredYears().get('005930')).toEqual([]);
      expect(actions.getCoveredYears().get('005930')).toEqual([]);
      expect(financial.getCollectedYears().get('005930')).toEqual([2024, 2025]);
    } finally { database.close(); }
  });

  it.each(['FINANCIAL', 'ACTIONS'] as const)('%s 증분 수집은 해시만 바뀐 과거 입력을 다시 요청하지 않는다', async (kind) => {
    const { database } = setup();
    try {
      const historical = database.db.select().from(facts).all();
      const financial = new SqliteFactCoverageStore(database.db, { collectionVersion: currentVersion });
      const actions = new SqliteCorporateActionCoverageStore(database.db, { collectionVersion: currentVersion });
      const source: FactSource = {
        fetchFinancials: vi.fn(async () => ({ facts: [], gaps: [] })),
        fetchCorporateActions: vi.fn(async () => ({ facts: [], gaps: [] })),
        listRecentPeriodicFilings: async () => [],
      };
      const service = new FactSyncService(source, new SqliteFactRepository(database.db), pino({ enabled: false }), { bumpVersion() {} }, { now: () => nowMs }, financial, actions);
      const request = { symbols: ['005930'], fromYear: 2025, toYear: 2025, mode: 'INCREMENTAL' as const, consolidated: true };
      const report = kind === 'FINANCIAL' ? await service.sync(request) : await service.syncCorporateActions(request);
      expect(report.stopReason).toBeNull();
      expect(source.fetchCorporateActions).not.toHaveBeenCalled();
      expect(source.fetchFinancials).not.toHaveBeenCalled();
      expect(database.db.select().from(facts).all()).toEqual(historical);
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

describe('B: KRX 과거 수집 이력 재사용', () => {
  it.each([previousVersion, null])('이전 표식 %s의 봉·coverage·선정 지표를 요청 없이 보존한다', async (storedVersion) => {
    const { database, source, service } = setupMarket();
    try {
      const previous = service(previousVersion);
      await previous.ingestDate('2026-01-05');
      await previous.ingestDate('2026-01-06');
      database.db.update(symbolMasterCoverage).set({ collectionVersion: storedVersion }).run();
      database.db.update(krxNonTradingCoverage).set({ collectionVersion: storedVersion }).run();
      database.db.update(dailySelectionMetricCoverage).set({ collectionVersion: storedVersion }).run();
      const historical = database.db.select().from(krxDailyBars).all();
      const originalCoverage = database.db.select().from(symbolMasterCoverage).all();
      const originalNonTrading = database.db.select().from(krxNonTradingCoverage).all();
      const originalMetrics = database.db.select().from(dailySelectionMetricCoverage).all();
      vi.mocked(source.fetchDailyTrades).mockClear();
      vi.mocked(source.fetchIssueBaseInfo).mockClear();
      const current = service(currentVersion);
      expect(current.isCovered('2026-01-06')).toBe(true);
      expect(current.isRangeCovered('2026-01-05', '2026-01-06')).toBe(true);
      expect(current.effectiveTradingDateWithinCoverage('2026-01-06')).toBe('2026-01-06');
      expect(current.isNonTradingRangeCovered('2026-01-05', '2026-01-06')).toBe(true);
      expect(await current.ensureTradingDay('2026-01-06')).toMatchObject({ effectiveTradingDate: '2026-01-06', ingestedDates: [] });
      await current.ensureSelectionMetrics(['2026-01-05', '2026-01-06']);
      await current.backfillNonTradingDays('2026-01-05', '2026-01-06');
      expect(await current.getMarketCapsAt('2026-01-05')).toEqual(new Map([['KR7005930003', '100000']]));
      expect(source.fetchDailyTrades).not.toHaveBeenCalled();
      expect(source.fetchIssueBaseInfo).not.toHaveBeenCalled();
      expect(database.db.select().from(krxDailyBars).all()).toEqual(historical);
      expect(database.db.select().from(symbolMasterCoverage).all()).toEqual(originalCoverage);
      expect(database.db.select().from(krxNonTradingCoverage).all()).toEqual(originalNonTrading);
      expect(database.db.select().from(dailySelectionMetricCoverage).all()).toEqual(originalMetrics);
      expect(service('c'.repeat(64)).isRangeCovered('2026-01-05', '2026-01-06')).toBe(true);
    } finally { database.close(); }
  });

  it('NULL·A·B 중첩 구간은 연결하지만 실제 결손 너머의 거래일 앵커는 쓰지 않는다', () => {
    const { database, service } = setupMarket();
    try {
      const ranges = [
        { startDate: '2026-01-01', endDate: '2026-01-03', syncedAtMs: 1, collectionVersion: null },
        { startDate: '2026-01-03', endDate: '2026-01-05', syncedAtMs: 2, collectionVersion: previousVersion },
        { startDate: '2026-01-07', endDate: '2026-01-08', syncedAtMs: 3, collectionVersion: currentVersion },
      ];
      database.db.insert(symbolMasterCoverage).values(ranges).run();
      database.db.insert(krxNonTradingCoverage).values(ranges).run();
      database.db.insert(symbolMasterTradingDays).values({ date: '2026-01-02' }).run();
      const current = service(currentVersion);
      expect(current.isRangeCovered('2026-01-01', '2026-01-05')).toBe(true);
      expect(current.isRangeCovered('2026-01-01', '2026-01-08')).toBe(false);
      expect(current.isCovered('2026-01-06')).toBe(false);
      expect(current.effectiveTradingDateWithinCoverage('2026-01-05')).toBe('2026-01-02');
      expect(current.effectiveTradingDateWithinCoverage('2026-01-08')).toBeUndefined();
      expect(current.isNonTradingRangeCovered('2026-01-01', '2026-01-05')).toBe(true);
      expect(current.isNonTradingRangeCovered('2026-01-01', '2026-01-08')).toBe(false);
    } finally { database.close(); }
  });

  it.each([previousVersion, null])('선정 지표 완료 표식 %s는 0건이어도 무자료와 미수집을 구분한다', async (storedVersion) => {
    const { database, source, service } = setupMarket();
    try {
      const current = service(currentVersion);
      await current.ingestDate('2026-01-05');
      database.db.update(dailySelectionMetricCoverage).set({ collectionVersion: storedVersion }).run();
      database.db.update(dailySelectionMetrics).set({ marketCapKrw: null, tradingValueKrw: null }).run();
      const metrics = new SelectionMetricRepository(database.db, { collectionVersion: currentVersion });
      expect(metrics.findMissingTradingValueDates(['2026-01-05', '2026-01-06'])).toEqual(['2026-01-06']);
      vi.mocked(source.fetchDailyTrades).mockClear();
      await current.ensureSelectionMetrics(['2026-01-05']);
      expect(await current.getMarketCapsAt('2026-01-05')).toEqual(new Map());
      expect(await current.getMarketCapsAt('2026-01-05')).toEqual(new Map());
      expect(source.fetchDailyTrades).not.toHaveBeenCalled();
    } finally { database.close(); }
  });
});
