import { describe, expect, it } from 'vitest';
import { SelectionMetricRepository } from '../../src/server/modules/market-data/application/selection-metric-repository.js';
import { createTestApp } from '../helpers/test-app.js';

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
});
