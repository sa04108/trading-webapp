import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { KrxHistoricalUniverseSource } from '../../src/server/modules/market-data/application/ports.js';
import { SymbolMasterService } from '../../src/server/modules/market-data/application/symbol-master-service.js';
import {
  symbolMasterCheckpointSymbols,
  symbolMasterCheckpoints,
  symbolMasterCoverage,
  symbolMasterEvents,
  symbolMasterStorageState,
  symbolMasterTradingDays,
  symbolMasterVersions,
} from '../../src/server/shared/db/schema.js';
import { createTestApp } from '../helpers/test-app.js';

const UNUSED_SOURCE: KrxHistoricalUniverseSource = {
  fetchDailyTrades: async () => [],
  fetchIssueBaseInfo: async () => [],
  todayMaxEndpointCallCount: () => 0,
};

describe('legacy 종목 마스터 → SCD 이행', () => {
  it('체크포인트 교정과 이벤트 이력을 보존하고 재실행은 멱등이다', async () => {
    const t = await createTestApp();
    try {
      const db = t.container.database.db;
      const now = t.container.clock.now();

      db.insert(symbolMasterCheckpoints).values([
        {
          id: 'cp-1',
          checkpointDate: '2023-01-02',
          source: 'KRX',
          verifiedAtMs: now,
          mismatchJson: null,
          createdAtMs: now,
        },
        {
          id: 'cp-2',
          checkpointDate: '2023-01-04',
          source: 'KRX',
          verifiedAtMs: null,
          mismatchJson: '{"corrected":true}',
          createdAtMs: now,
        },
      ]).run();
      db.insert(symbolMasterCheckpointSymbols).values([
        {
          checkpointId: 'cp-1',
          standardCode: 'KR7005930003',
          shortCode: '005930',
          name: '삼성전자',
          market: 'KOSPI',
          sharesOutstanding: '1000000',
          instrumentType: 'COMMON_STOCK',
          listedDate: '1975-06-11',
        },
        {
          checkpointId: 'cp-2',
          standardCode: 'KR7005930003',
          shortCode: '005931',
          name: '삼성전자',
          market: 'KOSPI',
          sharesOutstanding: '2000000',
          instrumentType: 'COMMON_STOCK',
          listedDate: '1975-06-12',
        },
      ]).run();
      db.insert(symbolMasterEvents).values({
        effectiveDate: '2023-01-03',
        standardCode: 'KR7005930003',
        eventType: 'SHARES_CHANGED',
        oldValue: JSON.stringify('1000000'),
        newValue: JSON.stringify('2000000'),
        observedSpanStart: '2023-01-02',
        createdAtMs: now,
      }).run();
      db.insert(symbolMasterTradingDays).values([
        { date: '2023-01-02' },
        { date: '2023-01-03' },
      ]).run();
      db.insert(symbolMasterCoverage).values({
        startDate: '2023-01-02',
        endDate: '2023-01-04',
        syncedAtMs: now,
      }).run();
      db.update(symbolMasterStorageState)
        .set({ phase: 'PENDING', migratedAtMs: null })
        .where(eq(symbolMasterStorageState.singleton, 1))
        .run();

      const createService = () => new SymbolMasterService({
        db,
        source: UNUSED_SOURCE,
        clock: t.container.clock,
        logger: t.container.logger,
      });
      const service = createService();

      expect(db.select().from(symbolMasterVersions)
        .orderBy(asc(symbolMasterVersions.validFromDate)).all()).toMatchObject([
        {
          validFromDate: '2023-01-02',
          validToDate: '2023-01-03',
          shortCode: '005930',
          sharesOutstanding: '1000000',
          listedDate: '1975-06-11',
        },
        {
          validFromDate: '2023-01-03',
          validToDate: '2023-01-04',
          shortCode: '005930',
          sharesOutstanding: '2000000',
          listedDate: '1975-06-11',
        },
        {
          validFromDate: '2023-01-04',
          validToDate: null,
          shortCode: '005931',
          sharesOutstanding: '2000000',
          listedDate: '1975-06-12',
        },
      ]);
      expect(service.getUniverseAsOf('2023-01-03').get('KR7005930003')).toMatchObject({
        shortCode: '005930',
        sharesOutstanding: '2000000',
      });
      expect(db.select().from(symbolMasterStorageState).get()).toMatchObject({ phase: 'ACTIVE' });
      expect(db.select().from(symbolMasterCheckpoints).all()).toHaveLength(0);
      expect(db.select().from(symbolMasterCheckpointSymbols).all()).toHaveLength(0);
      expect(db.select().from(symbolMasterEvents).all()).toHaveLength(0);
      expect(db.select().from(symbolMasterTradingDays)
        .orderBy(asc(symbolMasterTradingDays.date)).all()).toEqual([
        { date: '2023-01-02' },
        { date: '2023-01-03' },
      ]);

      createService();
      expect(db.select().from(symbolMasterVersions).all()).toHaveLength(3);
    } finally {
      await t.close();
    }
  });
});
