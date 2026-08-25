import { describe, expect, it } from 'vitest';
import { FinancialFactAvailabilityService } from '../../src/server/modules/facts/application/financial-fact-availability.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { facts } from '../../src/server/shared/db/schema.js';

describe('FinancialFactAvailabilityService', () => {
  it('종목별 PIT cutoff까지 실제 재무 fact가 있는 요청 종목만 돌려준다', () => {
    const database = openDatabase(':memory:');
    const cutoff = Date.parse('2025-12-31T23:59:59.999Z');
    database.db.insert(facts).values([
      {
        scope: 'SYMBOL', key: '005930', field: 'NET_INCOME', periodKey: '2025Q1',
        asOfTsMs: cutoff, value: 1, unit: 'KRW',
      },
      {
        scope: 'SYMBOL', key: '000660', field: 'SPLIT_RATIO', periodKey: '2025-01-02',
        asOfTsMs: cutoff - 1, value: 2, unit: 'RATIO',
      },
      {
        scope: 'SYMBOL', key: '035420', field: 'NET_INCOME', periodKey: '2025Q1',
        asOfTsMs: cutoff + 1, value: 1, unit: 'KRW',
      },
      {
        scope: 'MACRO', key: '005930', field: 'RATE', periodKey: '2025Q1',
        asOfTsMs: cutoff - 1, value: 1, unit: 'PCT',
      },
      {
        scope: 'SYMBOL', key: '999999', field: 'NET_INCOME', periodKey: '2025Q1',
        asOfTsMs: cutoff - 1, value: 1, unit: 'KRW',
      },
    ]).run();

    const service = new FinancialFactAvailabilityService(database.db);
    expect([...service.symbolsWithFinancialFacts(new Map([
      ['005930', cutoff],
      ['000660', cutoff],
      ['035420', cutoff],
    ]))]).toEqual(['005930']);
    expect(service.symbolsWithFinancialFacts(new Map()).size).toBe(0);
    database.close();
  });

  it('종목별 마지막 실행 봉 뒤의 재무 fact는 다른 종목의 늦은 봉으로 보이지 않는다', () => {
    const database = openDatabase(':memory:');
    database.db.insert(facts).values([
      {
        scope: 'SYMBOL', key: 'EARLY_STOP', field: 'NET_INCOME', periodKey: '2025Q1',
        asOfTsMs: 200, value: 1, unit: 'KRW',
      },
      {
        scope: 'SYMBOL', key: 'LATE_BAR', field: 'NET_INCOME', periodKey: '2025Q1',
        asOfTsMs: 299, value: 1, unit: 'KRW',
      },
    ]).run();

    const service = new FinancialFactAvailabilityService(database.db);
    expect([...service.symbolsWithFinancialFacts(new Map([
      ['EARLY_STOP', 100],
      ['LATE_BAR', 300],
    ]))]).toEqual(['LATE_BAR']);
    database.close();
  });
});
