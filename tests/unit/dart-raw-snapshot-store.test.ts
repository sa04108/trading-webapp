import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  type DartRawSnapshotKey,
} from '../../src/server/modules/facts/infrastructure/dart/dart-raw-snapshot-store.js';
import { SqliteDartRawSnapshotStore } from '../../src/server/modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { dartRawApiSnapshots, symbols } from '../../src/server/shared/db/schema.js';

const KEY: DartRawSnapshotKey = {
  symbol: '005930',
  endpoint: 'FINANCIAL_STATEMENT',
  businessYear: 2025,
  reportCode: '11013',
  fsDiv: 'CFS',
};

function setup() {
  const database = openDatabase(':memory:');
  database.db.insert(symbols).values({
    code: '005930',
    market: 'KR',
    name: '삼성전자',
    createdAtMs: 1,
  }).run();
  return { database, store: new SqliteDartRawSnapshotStore(database.db) };
}

describe('SqliteDartRawSnapshotStore', () => {
  it('미사용 필드와 행 순서를 포함한 응답 봉투를 그대로 저장하고 교체한다', () => {
    const { database, store } = setup();
    try {
      const first = {
        status: '000',
        message: '정상',
        list: [{ order: 1, unknown: '보존' }, { order: 2 }],
      };
      store.put(KEY, first, 100);
      expect(store.get(KEY)).toEqual({ payload: first, fetchedAtMs: 100 });
      expect(store.countMissing([
        KEY,
        { ...KEY, reportCode: '11012' },
      ], () => true)).toBe(1);

      const corrected = { status: '013', message: '정정 후 무자료' };
      store.put(KEY, corrected, 200);
      expect(store.get(KEY)).toEqual({ payload: corrected, fetchedAtMs: 200 });
    } finally {
      database.close();
    }
  });

  it('내용 해시가 맞지 않는 snapshot은 cache miss로 처리한다', () => {
    const { database, store } = setup();
    try {
      store.put(KEY, { status: '013', message: '없음' }, 100);
      database.db
        .update(dartRawApiSnapshots)
        .set({ payloadJson: '{"status":"000","message":"변조"}' })
        .where(eq(dartRawApiSnapshots.code, KEY.symbol))
        .run();

      expect(store.get(KEY)).toBeNull();
      expect(store.countMissing([KEY], () => true)).toBe(1);
    } finally {
      database.close();
    }
  });

  it('복합 키를 50개씩 나눠 필요한 원문만 검사한다', () => {
    const { database, store } = setup();
    try {
      const keys = Array.from({ length: 51 }, (_, index): DartRawSnapshotKey => ({
        ...KEY,
        businessYear: 1950 + index,
      }));
      store.put(keys[0]!, { status: '013', message: '첫 batch' }, 100);
      store.put(keys[50]!, { status: '013', message: '둘째 batch' }, 200);

      expect(store.countMissing(keys, () => true)).toBe(49);
      expect(store.countMissing([keys[0]!], () => false)).toBe(1);
    } finally {
      database.close();
    }
  });
});
