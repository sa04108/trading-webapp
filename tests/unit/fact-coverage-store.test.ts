import { describe, expect, it } from 'vitest';
import { SqliteFactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { datasets } from '../../src/server/shared/db/schema.js';

function setup() {
  const database = openDatabase(':memory:');
  database.db
    .insert(datasets)
    .values({
      id: 'ds-1',
      name: 'test',
      market: 'KR',
      timeframe: '1d',
      symbolsJson: JSON.stringify(['005930']),
      description: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    })
    .run();
  return { database, store: new SqliteFactCoverageStore(database.db) };
}

describe('SqliteFactCoverageStore', () => {
  it('기록이 없으면 빈 Map 이다', () => {
    const { store, database } = setup();
    expect(store.getCoveredYears('ds-1').size).toBe(0);
    database.close();
  });

  it('기록한 연도를 되돌려준다', () => {
    const { store, database } = setup();
    store.addCoveredYears('ds-1', '005930', [2021, 2020], 100);
    expect(store.getCoveredYears('ds-1').get('005930')).toEqual([2020, 2021]);
    database.close();
  });

  it('여러 번 기록하면 합집합이 되고 중복은 접힌다', () => {
    const { store, database } = setup();
    store.addCoveredYears('ds-1', '005930', [2020, 2021], 100);
    store.addCoveredYears('ds-1', '005930', [2021, 2022], 200);
    expect(store.getCoveredYears('ds-1').get('005930')).toEqual([2020, 2021, 2022]);
    database.close();
  });

  it('종목별로 따로 기록된다', () => {
    const { store, database } = setup();
    store.addCoveredYears('ds-1', '005930', [2020], 100);
    store.addCoveredYears('ds-1', '000660', [2021], 100);
    const covered = store.getCoveredYears('ds-1');
    expect(covered.get('005930')).toEqual([2020]);
    expect(covered.get('000660')).toEqual([2021]);
    database.close();
  });

  it('빈 연도 목록은 기록하지 않는다', () => {
    const { store, database } = setup();
    store.addCoveredYears('ds-1', '005930', [], 100);
    expect(store.getCoveredYears('ds-1').size).toBe(0);
    database.close();
  });

  it('깨진 JSON 은 빈 목록으로 읽어 수집을 멈추지 않는다', () => {
    const { store, database } = setup();
    database.sqlite
      .prepare(
        'INSERT INTO dataset_facts_state (dataset_id, symbol, covered_years_json, updated_at_ms) VALUES (?, ?, ?, ?)',
      )
      .run('ds-1', '005930', '{not json', 1);
    expect(store.getCoveredYears('ds-1').get('005930')).toEqual([]);
    database.close();
  });
});
