import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { SqliteCorporateActionCoverageStore } from '../../src/server/modules/facts/application/corporate-action-coverage.js';
import { symbolFactsState, symbols as symbolsTable } from '../../src/server/shared/db/schema.js';

let t: TestApp;

afterEach(async () => {
  await t.close();
});

async function setup() {
  t = await createTestApp();
  const db = t.container.database.db;
  db.insert(symbolsTable)
    .values([
      { code: '005930', market: 'KR', name: null, createdAtMs: 1 },
      { code: '000660', market: 'KR', name: null, createdAtMs: 1 },
    ])
    .run();
  return { db, store: new SqliteCorporateActionCoverageStore(db) };
}

describe('SqliteCorporateActionCoverageStore', () => {
  it('수집 연도를 합집합으로 더한다', async () => {
    const { store } = await setup();
    store.addCoveredYears('005930', [2025], 100);
    store.addCoveredYears('005930', [2026], 200);
    expect(store.getCoveredYears().get('005930')).toEqual([2025, 2026]);
  });

  it('gap 연도를 따로 관리한다', async () => {
    const { store } = await setup();
    store.addCoveredYears('005930', [2025], 100);
    store.addGapYears('005930', [2026], 100);
    expect(store.getCoveredYears().get('005930')).toEqual([2025]);
    expect(store.getGapYears().get('005930')).toEqual([2026]);
  });

  it('재무 커버리지를 건드리지 않는다', async () => {
    const { db, store } = await setup();
    db.insert(symbolFactsState)
      .values({ code: '005930', coveredYearsJson: JSON.stringify([2019]), updatedAtMs: 1 })
      .run();

    store.addCoveredYears('005930', [2025], 100);

    const row = db
      .select()
      .from(symbolFactsState)
      .all()
      .find((r) => r.code === '005930');
    expect(row?.coveredYearsJson).toBe(JSON.stringify([2019]));
    expect(store.getCoveredYears().get('005930')).toEqual([2025]);
  });

  it('없는 종목은 조회되지 않는다', async () => {
    const { store } = await setup();
    expect(store.getCoveredYears().get('999999')).toBeUndefined();
    expect(store.getGapYears().get('999999')).toBeUndefined();
  });

  it('연도를 오름차순으로 돌려준다', async () => {
    const { store } = await setup();
    store.addCoveredYears('005930', [2026, 2020, 2023], 100);
    expect(store.getCoveredYears().get('005930')).toEqual([2020, 2023, 2026]);
  });
});
