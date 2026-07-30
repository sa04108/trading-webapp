import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { brokerSyncState, dataCoverage, datasets } from '../../src/server/shared/db/schema.js';

let dir: string;
let handle: DatabaseHandle;
let db: AppDatabase;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'slice-schema-'));
  handle = openDatabase(join(dir, 'test.sqlite'));
  db = handle.db;
});
afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('슬라이스 스키마', () => {
  it('datasets 에 defaultTimeframe·symbolsKey, coverage·sync_state 에 slice 가 있다', () => {
    db.insert(datasets)
      .values({
        id: 'ds_t', name: 't', market: 'KR', timeframe: '1h',
        defaultTimeframe: '1m', symbolsKey: '005930',
        symbolsJson: '["005930"]', createdAtMs: 1, updatedAtMs: 1,
      })
      .run();
    db.insert(dataCoverage)
      .values({ datasetId: 'ds_t', symbol: '005930', slice: '1m', barCount: 0, computedAtMs: 1 })
      .run();
    db.insert(brokerSyncState).values({ datasetId: 'ds_t', symbol: '005930', slice: '1m' }).run();

    expect(db.select().from(datasets).all()[0]?.defaultTimeframe).toBe('1m');
    expect(db.select().from(dataCoverage).all()[0]?.slice).toBe('1m');
    expect(db.select().from(brokerSyncState).all()[0]?.slice).toBe('1m');
  });

  it('sync_state 는 같은 (dataset, symbol) 에 슬라이스가 다르면 공존한다', () => {
    db.insert(brokerSyncState).values({ datasetId: 'ds_t', symbol: '005930', slice: '1d' }).run();
    expect(db.select().from(brokerSyncState).all()).toHaveLength(2);
  });
});
