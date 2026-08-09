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

    repository.upsertMany([{
      date: '2026-08-07',
      standardCode: 'KR7005930003',
      marketCapKrw: 123_456_789_012_345n,
      volume: null,
      tradingValueKrw: null,
    }]);
    repository.upsertMany([{
      date: '2026-08-07',
      standardCode: 'KR7005930003',
      marketCapKrw: 123_456_789_012_345n,
      volume: 2,
      tradingValueKrw: 987_654_321_098_765n,
    }]);

    expect(repository.getAt('2026-08-07', ['KR7005930003'])).toEqual(new Map([[
      'KR7005930003',
      {
        date: '2026-08-07',
        standardCode: 'KR7005930003',
        marketCapKrw: 123_456_789_012_345n,
        volume: 2,
        tradingValueKrw: 987_654_321_098_765n,
      },
    ]]));
    await t.close();
  });

  it('거래대금 행이 없거나 nullable 이면 해당 날짜를 다시 수집 대상으로 돌려준다', async () => {
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
