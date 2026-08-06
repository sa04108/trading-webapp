import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import {
  symbolMasterCheckpoints,
  symbolMasterCheckpointSymbols,
  symbolMasterCoverage,
  symbolMasterEvents,
  symbolMasterMarketCaps,
} from '../../src/server/shared/db/schema.js';

describe('symbol master 스키마', () => {
  it('테이블 5개에 삽입·조회가 왕복한다', async () => {
    const t = await createTestApp();
    const db = t.container.database.db;
    db.insert(symbolMasterCheckpoints).values({
      id: 'cp1', checkpointDate: '2023-01-02', source: 'KRX', createdAtMs: 1,
    }).run();
    db.insert(symbolMasterCheckpointSymbols).values({
      checkpointId: 'cp1', standardCode: 'KR7005930003', shortCode: '005930',
      name: '삼성전자', market: 'KOSPI', sharesOutstanding: '5969782550',
      instrumentType: 'COMMON_STOCK', listedDate: '1975-06-11',
    }).run();
    db.insert(symbolMasterEvents).values({
      effectiveDate: '2023-01-03', standardCode: 'KR7005930003',
      eventType: 'SHARES_CHANGED', oldValue: '"5969782550"', newValue: '"5919637922"',
      observedSpanStart: '2023-01-02', createdAtMs: 2,
    }).run();
    db.insert(symbolMasterCoverage).values({
      startDate: '2023-01-02', endDate: '2023-01-03', syncedAtMs: 3,
    }).run();
    db.insert(symbolMasterMarketCaps).values({
      date: '2023-01-03', standardCode: 'KR7005930003', marketCapKrw: '350000000000000',
    }).run();

    expect(db.select().from(symbolMasterCheckpointSymbols).all()).toHaveLength(1);
    expect(db.select().from(symbolMasterEvents).all()).toHaveLength(1);
    await t.close();
  });
});
