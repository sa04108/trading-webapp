import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { symbols, universeSnapshots, universeSnapshotSymbols } from '../../src/server/shared/db/schema.js';

describe('universe snapshot 스키마', () => {
  let dir: string;
  let handle: DatabaseHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usn-schema-'));
    handle = openDatabase(join(dir, 'test.sqlite'));
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertSnapshot(id: string) {
    handle.db.insert(universeSnapshots).values({
      id,
      sourceKind: 'KRX_HISTORICAL',
      requestedDate: '2025-01-01',
      effectiveTradingDate: '2024-12-30',
      usableFromDate: '2024-12-31',
      usableFromRule: 'NEXT_SESSION_CONSERVATIVE_V1',
      marketsJson: '["KOSPI","KOSDAQ"]',
      filterPolicyVersion: 'krx-common-stock-v1',
      contractVersion: 'v1',
      sortKey: 'MKTCAP',
      sortDirection: 'DESC',
      selectionMethod: 'TOP_MARKET_CAP_N',
      selectionN: 200,
      selectedCount: 1,
      eligibleCount: 900,
      unknownMarketCapCount: 0,
      excludedByTypeJson: '{}',
      rawCountsJson: '{"KOSPI":950,"KOSDAQ":1700}',
      selectionHash: 'h1',
      candidateCanonicalHash: 'h2',
      krxApprovalExpiryDate: null,
      createdAtMs: 1,
    }).run();
  }

  function insertSnapshotSymbol(snapshotId: string, standardCode = 'KR7005930003') {
    handle.db.insert(universeSnapshotSymbols).values({
      snapshotId,
      standardCode,
      shortCode: '005930',
      nameAtSelection: '삼성전자',
      marketAtSelection: 'KOSPI',
      marketCapKrw: '350000000000000',
      rank: 1,
      instrumentType: 'COMMON_STOCK',
    }).run();
  }

  it('스냅샷과 종목 값 행의 대표 필드를 그대로 저장한다', () => {
    insertSnapshot('usn_1');
    insertSnapshotSymbol('usn_1');

    expect(handle.db.select().from(universeSnapshotSymbols).all()).toEqual([
      expect.objectContaining({
        snapshotId: 'usn_1',
        standardCode: 'KR7005930003',
        shortCode: '005930',
        nameAtSelection: '삼성전자',
        marketAtSelection: 'KOSPI',
        marketCapKrw: '350000000000000',
        rank: 1,
        instrumentType: 'COMMON_STOCK',
      }),
    ]);
  });

  it('스냅샷 종목 행은 symbols 삭제에 cascade 되지 않는 값 스냅샷이다', () => {
    insertSnapshot('usn_1');
    insertSnapshotSymbol('usn_1');
    handle.db.insert(symbols).values({
      code: '005930', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR7005930003',
    }).run();

    handle.db.delete(symbols).run();

    expect(handle.db.select().from(universeSnapshotSymbols).all()).toHaveLength(1);
  });

  it('스냅샷 삭제는 그 종목 값 행을 함께 삭제한다', () => {
    insertSnapshot('usn_1');
    insertSnapshotSymbol('usn_1');

    handle.db.delete(universeSnapshots).run();

    expect(handle.db.select().from(universeSnapshotSymbols).all()).toHaveLength(0);
  });

  it('같은 표준코드는 스냅샷마다 하나씩 저장할 수 있다', () => {
    insertSnapshot('usn_1');
    insertSnapshotSymbol('usn_1');
    insertSnapshot('usn_2');

    insertSnapshotSymbol('usn_2');

    expect(handle.db.select().from(universeSnapshotSymbols).all()).toHaveLength(2);
  });

  it('같은 스냅샷 안에서 표준코드는 유일하다', () => {
    insertSnapshot('usn_1');
    insertSnapshotSymbol('usn_1');

    expect(() => insertSnapshotSymbol('usn_1')).toThrow();
  });

  it('symbols.standard_code 는 unique 고 null 은 여러 개 허용된다', () => {
    handle.db.insert(symbols).values({
      code: 'A', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR700A',
    }).run();
    handle.db.insert(symbols).values({ code: 'B', market: 'KR', name: null, createdAtMs: 1 }).run();
    handle.db.insert(symbols).values({ code: 'C', market: 'KR', name: null, createdAtMs: 1 }).run();

    expect(() =>
      handle.db.insert(symbols).values({
        code: 'D', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR700A',
      }).run(),
    ).toThrow();
  });
});
