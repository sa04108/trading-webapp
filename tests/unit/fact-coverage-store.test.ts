import { describe, expect, it } from 'vitest';
import { SqliteFactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { symbols as symbolsTable } from '../../src/server/shared/db/schema.js';

function setup() {
  const database = openDatabase(':memory:');
  database.db
    .insert(symbolsTable)
    .values([
      { code: '005930', market: 'KR', name: null, createdAtMs: 1 },
      { code: '000660', market: 'KR', name: null, createdAtMs: 1 },
    ])
    .run();
  return { database, store: new SqliteFactCoverageStore(database.db) };
}

describe('SqliteFactCoverageStore', () => {
  it('기록이 없으면 빈 Map 이다', () => {
    const { store, database } = setup();
    expect(store.getCoveredYears().size).toBe(0);
    database.close();
  });

  it('기록한 연도를 되돌려준다', () => {
    const { store, database } = setup();
    store.addCoveredYears('005930', [2021, 2020], 100);
    expect(store.getCoveredYears().get('005930')).toEqual([2020, 2021]);
    database.close();
  });

  it('여러 번 기록하면 합집합이 되고 중복은 접힌다', () => {
    const { store, database } = setup();
    store.addCoveredYears('005930', [2020, 2021], 100);
    store.addCoveredYears('005930', [2021, 2022], 200);
    expect(store.getCoveredYears().get('005930')).toEqual([2020, 2021, 2022]);
    database.close();
  });

  it('종목별로 따로 기록된다', () => {
    const { store, database } = setup();
    store.addCoveredYears('005930', [2020], 100);
    store.addCoveredYears('000660', [2021], 100);
    const covered = store.getCoveredYears();
    expect(covered.get('005930')).toEqual([2020]);
    expect(covered.get('000660')).toEqual([2021]);
    database.close();
  });

  it('빈 연도 목록은 기록하지 않는다', () => {
    const { store, database } = setup();
    store.addCoveredYears('005930', [], 100);
    expect(store.getCoveredYears().size).toBe(0);
    database.close();
  });

  it('깨진 JSON 은 빈 목록으로 읽어 수집을 멈추지 않는다', () => {
    const { store, database } = setup();
    database.sqlite
      .prepare(
        'INSERT INTO symbol_facts_state (code, covered_years_json, updated_at_ms) VALUES (?, ?, ?)',
      )
      .run('005930', '{not json', 1);
    expect(store.getCoveredYears().get('005930')).toEqual([]);
    database.close();
  });
});
