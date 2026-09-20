import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  type DartRawSnapshotKey,
} from '../../src/server/modules/facts/infrastructure/dart/dart-raw-snapshot-store.js';
import { SqliteDartRawSnapshotStore } from '../../src/server/modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
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
  it('재개용 시각은 요청 종목의 모든 원문 중 가장 이른 값이고 없는 종목은 만들지 않는다', () => {
    const { database, store } = setup();
    try {
      store.put(KEY, { status: '013', message: '없음' }, 200);
      store.put({ ...KEY, endpoint: 'SHARE_STATUS', fsDiv: 'NONE' }, { status: '013' }, 100);
      expect(store.getOldestFetchedAtMs(['005930', '005930', '000660'])).toEqual(new Map([['005930', 100]]));
      expect(store.getOldestFetchedAtMs(['000660'])).toEqual(new Map());
      expect(store.getOldestFetchedAtMs([])).toEqual(new Map());
    } finally {
      database.close();
    }
  });

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

  it('내용 해시 불일치는 부재와 구별하여 재수집을 차단한다', () => {
    const { database, store } = setup();
    try {
      store.put(KEY, { status: '013', message: '없음' }, 100);
      database.db
        .update(dartRawApiSnapshots)
        .set({ payloadJson: '{"status":"000","message":"변조"}' })
        .where(eq(dartRawApiSnapshots.code, KEY.symbol))
        .run();

      expect(() => store.get(KEY)).toThrow(/HASH_MISMATCH/);
      expect(() => store.countMissing([KEY], () => true)).toThrow(/HASH_MISMATCH/);
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
      expect(() => store.countMissing([keys[0]!], () => false)).toThrow(/PARSER_INCOMPATIBLE/);
    } finally {
      database.close();
    }
  });
});


it('현재 기대 해시와 정확히 같은 보존본만 로컬에서 복구한다', () => {
  const {database,store} = setup();
  try {
    const payload = {status:'013',message:'동일 원문'};
    store.put(KEY,payload,100);
    store.put(KEY,payload,200);
    database.db.update(dartRawApiSnapshots).set({payloadJson:'변조'}).where(eq(dartRawApiSnapshots.code,KEY.symbol)).run();
    expect(store.get(KEY)).toEqual({payload,fetchedAtMs:200});
    expect(store.countMissing([KEY],()=>true)).toBe(0);
  } finally { database.close(); }
});

it('게시 대기 봉투를 보존해도 이전 활성 원문은 교체하지 않는다', () => {
  const {database,store} = setup();
  try {
    const previous = {status:'000',list:[{rcept_no:'20250515000001'}]};
    store.put(KEY,previous,1);
    store.observe(KEY,{status:'013',message:'게시 대기'},2);
    expect(store.get(KEY)).toEqual({payload:previous,fetchedAtMs:1});
    const row = database.sqlite.prepare('SELECT snapshot_json FROM dart_raw_api_snapshot_history').get() as {snapshot_json:string};
    expect(JSON.parse(row.snapshot_json)).toMatchObject({kind:'PENDING_PUBLICATION',payloadJson:'{"status":"013","message":"게시 대기"}',fetchedAtMs:2});
  } finally { database.close(); }
});
