import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { symbols, universeSnapshots, universeSnapshotSymbols } from '../../src/server/shared/db/schema.js';

describe('universe snapshot 스키마', () => {
  let dir: string;
  let handle: DatabaseHandle;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'usn-schema-'));
    handle = openDatabase(join(dir, 'test.sqlite'));
  });
  afterAll(() => { handle.close(); rmSync(dir, { recursive: true, force: true }); });

  it('스냅샷과 종목 값 행을 저장한다', () => {
    handle.db.insert(universeSnapshots).values({
      id: 'usn_1', sourceKind: 'KRX_HISTORICAL', requestedDate: '2025-01-01',
      effectiveTradingDate: '2024-12-30', usableFromDate: '2024-12-31',
      usableFromRule: 'NEXT_SESSION_CONSERVATIVE_V1', marketsJson: '["KOSPI","KOSDAQ"]',
      filterPolicyVersion: 'krx-common-stock-v1', contractVersion: 'v1',
      sortKey: 'MKTCAP', sortDirection: 'DESC', selectionMethod: 'TOP_MARKET_CAP_N', selectionN: 200,
      selectedCount: 1, eligibleCount: 900, unknownMarketCapCount: 0,
      excludedByTypeJson: '{}', rawCountsJson: '{"KOSPI":950,"KOSDAQ":1700}',
      selectionHash: 'h1', candidateCanonicalHash: 'h2',
      krxApprovalExpiryDate: null, createdAtMs: 1,
    }).run();
    handle.db.insert(universeSnapshotSymbols).values({
      snapshotId: 'usn_1', standardCode: 'KR7005930003', shortCode: '005930',
      nameAtSelection: '삼성전자', marketAtSelection: 'KOSPI',
      marketCapKrw: '350000000000000', rank: 1, instrumentType: 'COMMON_STOCK',
    }).run();
    expect(handle.db.select().from(universeSnapshotSymbols).all()).toHaveLength(1);
  });

  it('스냅샷 종목 행은 symbols 삭제에 cascade 되지 않는 값 스냅샷이다', () => {
    handle.db.insert(symbols).values({ code: '005930', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR7005930003' }).run();
    handle.db.delete(symbols).run();
    expect(handle.db.select().from(universeSnapshotSymbols).all()).toHaveLength(1);
  });

  it('같은 스냅샷 안에서 표준코드는 유일하다', () => {
    expect(() =>
      handle.db.insert(universeSnapshotSymbols).values({
        snapshotId: 'usn_1', standardCode: 'KR7005930003', shortCode: '005930X',
        nameAtSelection: 'dup', marketAtSelection: 'KOSPI', marketCapKrw: null, rank: null,
        instrumentType: 'COMMON_STOCK',
      }).run(),
    ).toThrow();
  });

  it('symbols.standard_code 는 unique 고 null 은 여러 개 허용된다', () => {
    handle.db.insert(symbols).values({ code: 'A', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR700A' }).run();
    handle.db.insert(symbols).values({ code: 'B', market: 'KR', name: null, createdAtMs: 1 }).run();
    handle.db.insert(symbols).values({ code: 'C', market: 'KR', name: null, createdAtMs: 1 }).run();
    expect(() =>
      handle.db.insert(symbols).values({ code: 'D', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR700A' }).run(),
    ).toThrow();
  });
});
