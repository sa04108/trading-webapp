import { describe, expect, it } from 'vitest';
import { SelectionMetricRepository } from '../../src/server/modules/market-data/application/selection-metric-repository.js';
import { createTestApp } from '../helpers/test-app.js';

// better-sqlite3 in this project accepts 250,000 variables. This deliberately
// crosses that real execution boundary; production batching remains 500 to
// honor the project's portable 999-bind limit.
const OVER_SQLITE_BIND_LIMIT = 250_001;

describe('SelectionMetricRepository', () => {
  it('같은 날짜·표준코드의 metric 을 bigint 정밀도 그대로 upsert 한다', async () => {
    const t = await createTestApp();
    const repository = new SelectionMetricRepository(t.container.database.db);

    // 2^53+1 과 2^63 초과 값 — 내부에서 Number() 를 거치는 구현은 여기서 깨진다.
    const overDoubleCap = 9_007_199_254_740_993n;
    const overInt64TradingValue = 18_446_744_073_709_551_617n;
    repository.upsertMany([{
      date: '2026-08-07',
      standardCode: 'KR7005930003',
      marketCapKrw: overDoubleCap,
      volume: null,
      tradingValueKrw: null,
    }]);
    repository.upsertMany([{
      date: '2026-08-07',
      standardCode: 'KR7005930003',
      marketCapKrw: overDoubleCap,
      volume: 2,
      tradingValueKrw: overInt64TradingValue,
    }]);

    expect(repository.getAt('2026-08-07', ['KR7005930003'])).toEqual(new Map([[
      'KR7005930003',
      {
        date: '2026-08-07',
        standardCode: 'KR7005930003',
        marketCapKrw: overDoubleCap,
        volume: 2,
        tradingValueKrw: overInt64TradingValue,
      },
    ]]));
    await t.close();
  });

  it('거래대금 행이 없거나 전부 null 이면 해당 날짜를 다시 수집 대상으로 돌려준다', async () => {
    const t = await createTestApp();
    const repository = new SelectionMetricRepository(t.container.database.db);
    repository.upsertMany([{
      date: '2026-08-07',
      standardCode: 'KR7005930003',
      marketCapKrw: 1n,
      volume: 2,
      tradingValueKrw: null,
    }, {
      date: '2026-08-08',
      standardCode: 'KR7005930003',
      marketCapKrw: null,
      volume: null,
      tradingValueKrw: 3n,
    }]);

    expect(repository.findMissingTradingValueDates(['2026-08-06', '2026-08-07', '2026-08-08']))
      .toEqual(['2026-08-06', '2026-08-07']);
    await t.close();
  });

  it('일부 종목의 거래대금이 영영 null 이어도 ingest 흔적이 있는 날짜는 재수집하지 않는다', async () => {
    const t = await createTestApp();
    const repository = new SelectionMetricRepository(t.container.database.db);
    // KRX 가 '-' 거래대금을 준 종목은 null 로 남는다. 같은 transaction 의 다른 종목이
    // 값을 가지면 그 날짜는 이미 수집한 것이다.
    repository.upsertMany([{
      date: '2026-08-07',
      standardCode: 'KR7005930003',
      marketCapKrw: 1n,
      volume: 2,
      tradingValueKrw: null,
    }, {
      date: '2026-08-07',
      standardCode: 'KR7000660001',
      marketCapKrw: 4n,
      volume: 5,
      tradingValueKrw: 6n,
    }]);

    expect(repository.findMissingTradingValueDates(['2026-08-07'])).toEqual([]);
    await t.close();
  });

  it('표준코드가 SQLite bind 한도를 넘어도 getAt 결과를 합친다', async () => {
    const t = await createTestApp();
    const repository = new SelectionMetricRepository(t.container.database.db);
    repository.upsertMany([{
      date: '2026-08-07', standardCode: 'KR7005930003',
      marketCapKrw: 1n, volume: 2, tradingValueKrw: 3n,
    }]);
    const codes = ['KR7005930003', ...Array.from(
      { length: OVER_SQLITE_BIND_LIMIT - 1 },
      (_, index) => `KR7${String(index).padStart(9, '0')}`,
    )];

    expect(repository.getAt('2026-08-07', codes).get('KR7005930003')).toMatchObject({
      marketCapKrw: 1n, volume: 2, tradingValueKrw: 3n,
    });
    await t.close();
  });

  it('날짜가 SQLite bind 한도를 넘어도 findMissingTradingValueDates 결과를 합친다', async () => {
    const t = await createTestApp();
    const repository = new SelectionMetricRepository(t.container.database.db);
    repository.upsertMany([{
      date: '2026-08-07', standardCode: 'KR7005930003',
      marketCapKrw: 1n, volume: 2, tradingValueKrw: 3n,
    }]);
    const dates = ['2026-08-07', ...Array.from(
      { length: OVER_SQLITE_BIND_LIMIT - 1 },
      (_, index) => `2030-${String(Math.floor(index / 28) % 12 + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}-${index}`,
    )];

    const missing = repository.findMissingTradingValueDates(dates);

    expect(missing).toHaveLength(OVER_SQLITE_BIND_LIMIT - 1);
    expect(missing).not.toContain('2026-08-07');
    await t.close();
  });
});
