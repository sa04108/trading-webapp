import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import {
  datasetSymbols,
  datasets,
  symbolCoverage,
  symbolSlices,
  symbols,
} from '../../src/server/shared/db/schema.js';

let dir: string;
let handle: DatabaseHandle;
let db: DatabaseHandle['db'];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'slice-schema-'));
  handle = openDatabase(join(dir, 'test.sqlite'));
  db = handle.db;
});
afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 종목이 1급 객체가 된 뒤의 스키마 계약 (설계 2026-07-31-symbol-as-first-class).
 * 데이터셋에는 market·defaultTimeframe·symbolsJson 이 없고, 봉 상태는 (code, slice) 로 잡힌다.
 */
describe('종목 중심 스키마', () => {
  it('종목이 market 을 갖고, 커버리지·워터마크는 (code, slice) 로 잡힌다', () => {
    db.insert(symbols)
      .values({ code: '005930', market: 'KR', name: '삼성전자', createdAtMs: 1 })
      .run();
    db.insert(symbolCoverage)
      .values({ code: '005930', slice: '1m', barCount: 0, computedAtMs: 1 })
      .run();
    db.insert(symbolSlices).values({ code: '005930', slice: '1m' }).run();

    expect(db.select().from(symbols).all()[0]?.market).toBe('KR');
    expect(db.select().from(symbolCoverage).all()[0]?.slice).toBe('1m');
    expect(db.select().from(symbolSlices).all()[0]?.slice).toBe('1m');
  });

  it('같은 종목의 두 슬라이스가 공존한다 — 일봉과 분봉은 따로 수집된다', () => {
    db.insert(symbolSlices).values({ code: '005930', slice: '1d' }).run();
    expect(db.select().from(symbolSlices).all()).toHaveLength(2);
  });

  it('데이터셋은 참조 테이블로 종목을 가리킨다 — 종목 목록을 자기 안에 담지 않는다', () => {
    db.insert(datasets)
      .values({ id: 'ds_t', name: 't', description: null, createdAtMs: 1, updatedAtMs: 1 })
      .run();
    db.insert(datasetSymbols).values({ datasetId: 'ds_t', code: '005930' }).run();

    // drizzle select 는 선언된 컬럼만 돌려주므로 not.toHaveProperty 는 검증력이 없다 —
    // 실질 검증은 참조 테이블 왕복뿐이다
    expect(db.select().from(datasetSymbols).all()[0]?.code).toBe('005930');
  });
});
