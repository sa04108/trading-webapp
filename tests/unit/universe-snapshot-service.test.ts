import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditLogService } from '../../src/server/modules/audit/audit-service.js';
import {
  PreviewExpiredError,
  type HistoricalUniversePreview,
  type HistoricalUniverseService,
} from '../../src/server/modules/market-data/application/historical-universe-service.js';
import { KrxApprovalExpiredError } from '../../src/server/modules/market-data/application/ports.js';
import {
  SnapshotSelectionError,
  SymbolIdentityConflictError,
  UniverseSnapshotService,
} from '../../src/server/modules/market-data/application/universe-snapshot-service.js';
import {
  selectionPayloadOf,
  type EligibleCandidate,
} from '../../src/server/modules/market-data/domain/historical-universe.js';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import {
  symbols,
  universeSnapshots,
  universeSnapshotSymbols,
} from '../../src/server/shared/db/schema.js';
import type { Clock } from '../../src/server/shared/clock.js';
import type { Logger } from '../../src/server/shared/logger.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const EXPIRED_GUIDANCE = '미리보기가 만료되었거나 내용이 바뀌었습니다 — 다시 조회하세요.';

function candidate(
  shortCode: string,
  marketCapKrw: bigint | null,
  rank: number | null,
  market: 'KOSPI' | 'KOSDAQ' = 'KOSPI',
): EligibleCandidate {
  return {
    standardCode: `KR7${shortCode}003`,
    shortCode,
    name: `종목-${shortCode}`,
    market,
    marketCapKrw,
    rank,
  };
}

const A = candidate('000001', 300n, 1);
const B = candidate('000002', 200n, 2, 'KOSDAQ');
const C = candidate('000003', 100n, 3);
const UNKNOWN = candidate('000004', null, null, 'KOSDAQ');

function previewOf(
  candidates: readonly EligibleCandidate[] = [A, B, C],
): HistoricalUniversePreview {
  const canonicalPayload = [
    '2025-01-02|krx-common-stock-v1|v1',
    ...candidates.map((item) => [
      item.standardCode,
      item.shortCode,
      item.market,
      item.marketCapKrw?.toString() ?? 'unknown',
    ].join('|')),
  ].join('\n');
  return {
    previewId: 'uvp_test',
    requestedDate: '2025-01-04',
    effectiveTradingDate: '2025-01-02',
    usableFromDate: '2025-01-03',
    usableFromRule: 'NEXT_SESSION_CONSERVATIVE_V1',
    canonicalHash: createHash('sha256').update(canonicalPayload).digest('hex'),
    set: {
      effectiveTradingDate: '2025-01-02',
      candidates,
      rawCounts: { KOSPI: 4, KOSDAQ: 3 },
      eligibleCount: candidates.length,
      unknownMarketCapCount: candidates.filter((item) => item.marketCapKrw === null).length,
      excludedByType: { NON_STOCK_SECURITY: 2, PREFERRED_STOCK: 1 },
      filterPolicyVersion: 'krx-common-stock-v1',
      contractVersion: 'v1',
      canonicalPayload,
    },
    fetchedAtMs: 10,
  };
}

class MutableClock implements Clock {
  constructor(private value = 1_000) {}
  now(): number { return this.value; }
  set(value: number): void { this.value = value; }
}

class FakeUniverse {
  standardCodeMapCalls = 0;
  standardCodeMap: ReadonlyMap<string, string> = new Map();
  onStandardCodeMap: (() => void) | null = null;
  /** 기본은 항상 사용 가능 — 승인 만료 시나리오는 테스트가 이 필드에 throw 하는 함수를 넣는다. */
  assertAvailableImpl: () => void = () => {};

  constructor(readonly storedPreview: HistoricalUniversePreview | null) {}

  assertAvailable(): void {
    this.assertAvailableImpl();
  }

  getPreview(previewId: string): HistoricalUniversePreview | null {
    return this.storedPreview?.previewId === previewId ? this.storedPreview : null;
  }

  async currentStandardCodeMap(): Promise<ReadonlyMap<string, string>> {
    this.standardCodeMapCalls += 1;
    this.onStandardCodeMap?.();
    return this.standardCodeMap;
  }
}

interface AuditEvent {
  readonly actor: string;
  readonly event: string;
  readonly detail: Record<string, unknown> | undefined;
}

class FakeAudit implements AuditLogService {
  readonly events: AuditEvent[] = [];
  onRecord: (() => void) | null = null;
  errorAfterRecord: Error | null = null;

  record(actor: string, event: string, detail?: Record<string, unknown>): void {
    this.onRecord?.();
    this.events.push({ actor, event, detail });
    if (this.errorAfterRecord) throw this.errorAfterRecord;
  }
}

interface Harness {
  readonly database: DatabaseHandle;
  readonly preview: HistoricalUniversePreview | null;
  readonly universe: FakeUniverse;
  readonly audit: FakeAudit;
  readonly clock: MutableClock;
  readonly service: UniverseSnapshotService;
}

const handles: DatabaseHandle[] = [];

function setup(
  storedPreview: HistoricalUniversePreview | null = previewOf(),
  options: { readonly logger?: Logger } = {},
): Harness {
  const database = openDatabase(':memory:');
  handles.push(database);
  const universe = new FakeUniverse(storedPreview);
  const audit = new FakeAudit();
  const clock = new MutableClock();
  const service = new UniverseSnapshotService({
    db: database.db,
    universe: universe as unknown as HistoricalUniverseService,
    clock,
    audit,
    logger: options.logger ?? LOGGER,
    approvalExpiry: '2027-12-31',
  });
  return { database, preview: storedPreview, universe, audit, clock, service };
}

function manual(
  service: UniverseSnapshotService,
  selectedStandardCodes: readonly string[],
) {
  return service.createFromPreview({
    previewId: 'uvp_test',
    selectedStandardCodes,
    selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
    selectionN: null,
  });
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

describe('UniverseSnapshotService', () => {
  it('만료·부재 previewId는 정확한 재조회 안내를 담은 PreviewExpiredError다', async () => {
    const { service, database, audit } = setup(null);

    const result = manual(service, [A.standardCode]);

    await expect(result).rejects.toEqual(expect.objectContaining({
      name: 'PreviewExpiredError',
      message: EXPIRED_GUIDANCE,
    }));
    await expect(result).rejects.toBeInstanceOf(PreviewExpiredError);
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('승인 만료 뒤에는 만료 전에 캐시된 previewId로도 스냅샷을 저장할 수 없다', async () => {
    const { service, database, audit, universe } = setup();
    // getPreview 는 순수 캐시 조회라 만료를 모른다 — createFromPreview 진입 시
    // assertAvailable() 을 직접 태워야 승인 만료 뒤 저장을 막을 수 있다.
    universe.assertAvailableImpl = () => {
      throw new KrxApprovalExpiredError('KRX Open API 사용 승인 만료일(2025-12-31)이 지났습니다. API별 승인 상태를 확인하세요.');
    };

    await expect(manual(service, [A.standardCode])).rejects.toBeInstanceOf(KrxApprovalExpiredError);

    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('후보에 없는 표준코드와 중복 선택을 SnapshotSelectionError로 거부한다', async () => {
    const { service, database } = setup();

    await expect(manual(service, ['KR7-NOT-A-CANDIDATE']))
      .rejects.toBeInstanceOf(SnapshotSelectionError);
    await expect(manual(service, [A.standardCode, A.standardCode]))
      .rejects.toBeInstanceOf(SnapshotSelectionError);
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
  });

  it('TOP_MARKET_CAP_N은 unknown 후보가 하나라도 있으면 거부한다', async () => {
    const { service } = setup(previewOf([A, B, UNKNOWN]));

    await expect(service.createFromPreview({
      previewId: 'uvp_test',
      selectedStandardCodes: [A.standardCode, B.standardCode],
      selectionMethod: 'TOP_MARKET_CAP_N',
      selectionN: 2,
    })).rejects.toBeInstanceOf(SnapshotSelectionError);
  });

  it('TOP_MARKET_CAP_N은 선택 집합이 정확히 상위 N과 같아야 한다', async () => {
    const { service, database } = setup();

    await expect(service.createFromPreview({
      previewId: 'uvp_test',
      selectedStandardCodes: [A.standardCode, C.standardCode],
      selectionMethod: 'TOP_MARKET_CAP_N',
      selectionN: 2,
    })).rejects.toBeInstanceOf(SnapshotSelectionError);

    const saved = await service.createFromPreview({
      previewId: 'uvp_test',
      selectedStandardCodes: [B.standardCode, A.standardCode],
      selectionMethod: 'TOP_MARKET_CAP_N',
      selectionN: 2,
    });

    expect(saved).toMatchObject({ selectionMethod: 'TOP_MARKET_CAP_N', selectionN: 2, selectedCount: 2 });
    expect(database.db.select().from(universeSnapshotSymbols).all()).toHaveLength(2);
  });

  it('적격 후보 수가 화면 상수(예: 200)보다 적으면 selectionN 은 실제 후보 수를 보내야 통과한다', async () => {
    // krx-snapshot-step.tsx 의 confirm() 회귀 재현: 적격 후보가 TOP_N(200) 보다 적을 때
    // 클라이언트가 여전히 상수 200 을 selectionN 으로 보내면(과거 버그) 서버가 기대하는
    // 「상위 N」의 N 과 어긋나 정당한 확정이 거부된다. 실제 개수(여기서는 전체 3개)를
    // 보내면 통과해야 한다.
    const { service, database } = setup(); // previewOf() 는 A·B·C 3개뿐이다

    await expect(service.createFromPreview({
      previewId: 'uvp_test',
      selectedStandardCodes: [A.standardCode, B.standardCode, C.standardCode],
      selectionMethod: 'TOP_MARKET_CAP_N',
      selectionN: 200, // 화면 상수를 그대로 보낸 경우 — 실제 후보(3)와 달라 거부돼야 한다
    })).rejects.toBeInstanceOf(SnapshotSelectionError);

    const saved = await service.createFromPreview({
      previewId: 'uvp_test',
      selectedStandardCodes: [A.standardCode, B.standardCode, C.standardCode],
      selectionMethod: 'TOP_MARKET_CAP_N',
      selectionN: 3, // 고친 뒤: 실제 상위 선택 크기를 보낸 경우 — 통과해야 한다
    });

    expect(saved).toMatchObject({ selectionMethod: 'TOP_MARKET_CAP_N', selectionN: 3, selectedCount: 3 });
    expect(database.db.select().from(universeSnapshots).all()).toHaveLength(1);
  });

  it.each([
    { method: 'TOP_MARKET_CAP_N' as const, n: null },
    { method: 'TOP_MARKET_CAP_N' as const, n: 1.5 },
    { method: 'MANUAL_FROM_KRX_SNAPSHOT' as const, n: 1 },
  ])('selectionMethod=$method와 selectionN=$n의 의미 불일치를 거부한다', async ({ method, n }) => {
    const { service } = setup();

    await expect(service.createFromPreview({
      previewId: 'uvp_test',
      selectedStandardCodes: [A.standardCode],
      selectionMethod: method,
      selectionN: n,
    })).rejects.toBeInstanceOf(SnapshotSelectionError);
  });

  it('선택 크기 1과 1000은 허용하고 0과 1001은 거부한다', async () => {
    const many = Array.from({ length: 1_001 }, (_, index) => (
      candidate(String(index + 1).padStart(6, '0'), BigInt(1_001 - index), index + 1)
    ));
    const { service } = setup(previewOf(many));

    await expect(manual(service, [])).rejects.toBeInstanceOf(SnapshotSelectionError);
    await expect(manual(service, many.map((item) => item.standardCode)))
      .rejects.toBeInstanceOf(SnapshotSelectionError);
    await expect(manual(service, [many[0]!.standardCode])).resolves.toMatchObject({ selectedCount: 1 });
    await expect(manual(service, many.slice(0, 1_000).map((item) => item.standardCode)))
      .resolves.toMatchObject({ selectedCount: 1_000 });
  });

  it('선택 종목만 신규 symbols에 code=shortCode, standardCode, market=KR, 당시 이름으로 등록한다', async () => {
    const { service, database } = setup();

    await manual(service, [B.standardCode]);

    expect(database.db.select().from(symbols).all()).toEqual([{
      code: B.shortCode,
      market: 'KR',
      name: B.name,
      standardCode: B.standardCode,
      createdAtMs: 1_000,
    }]);
  });

  it('기존 symbols 행의 standardCode가 같으면 수정하거나 중복 삽입하지 않고 재사용한다', async () => {
    const { service, database, universe } = setup();
    database.db.insert(symbols).values({
      code: A.shortCode,
      market: 'KR',
      name: '기존 이름',
      standardCode: A.standardCode,
      createdAtMs: 7,
    }).run();

    await manual(service, [A.standardCode]);

    expect(database.db.select().from(symbols).all()).toEqual([{
      code: A.shortCode,
      market: 'KR',
      name: '기존 이름',
      standardCode: A.standardCode,
      createdAtMs: 7,
    }]);
    expect(universe.standardCodeMapCalls).toBe(0);
  });

  it.each([
    ['매핑됨', A.standardCode],
    ['미매핑', null],
  ])('같은 단축코드의 기존 %s 행이라도 market이 KR이 아니면 identity 충돌이다', async (_label, standardCode) => {
    const { service, database, universe, audit } = setup();
    database.db.insert(symbols).values({
      code: A.shortCode,
      market: 'US',
      name: '다른 시장 종목',
      standardCode,
      createdAtMs: 7,
    }).run();
    universe.standardCodeMap = new Map([[A.shortCode, A.standardCode]]);

    await expect(manual(service, [A.standardCode]))
      .rejects.toBeInstanceOf(SymbolIdentityConflictError);

    expect(universe.standardCodeMapCalls).toBe(0);
    expect(database.db.select().from(symbols).all()[0]).toMatchObject({ market: 'US', standardCode });
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('같은 단축코드의 기존 행이 다른 standardCode면 SymbolIdentityConflictError다', async () => {
    const { service, database, universe } = setup();
    database.db.insert(symbols).values({
      code: A.shortCode,
      market: 'KR',
      name: '다른 종목',
      standardCode: 'KR7-DIFFERENT',
      createdAtMs: 7,
    }).run();

    await expect(manual(service, [A.standardCode]))
      .rejects.toBeInstanceOf(SymbolIdentityConflictError);
    expect(universe.standardCodeMapCalls).toBe(0);
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
  });

  it('선택 표준코드를 다른 단축코드 행이 이미 소유하면 트랜잭션 전에 identity 충돌로 거부한다', async () => {
    const { service, database } = setup();
    database.db.insert(symbols).values({
      code: '999999',
      market: 'KR',
      name: '표준코드 소유자',
      standardCode: A.standardCode,
      createdAtMs: 7,
    }).run();

    await expect(manual(service, [A.standardCode]))
      .rejects.toBeInstanceOf(SymbolIdentityConflictError);
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
  });

  it('기존 미매핑 행들은 현재 KRX 맵을 트랜잭션 밖에서 한 번만 조회해 검증한 뒤 백필한다', async () => {
    const { service, database, universe } = setup();
    database.db.insert(symbols).values([
      { code: A.shortCode, market: 'KR', name: '기존 A', createdAtMs: 7 },
      { code: C.shortCode, market: 'KR', name: '기존 C', createdAtMs: 8 },
    ]).run();
    universe.standardCodeMap = new Map([
      [A.shortCode, A.standardCode],
      [C.shortCode, C.standardCode],
    ]);
    universe.onStandardCodeMap = () => {
      expect(database.sqlite.inTransaction).toBe(false);
    };

    await manual(service, [C.standardCode, A.standardCode]);

    expect(universe.standardCodeMapCalls).toBe(1);
    expect(database.db.select().from(symbols).all()).toEqual([
      { code: A.shortCode, market: 'KR', name: '기존 A', standardCode: A.standardCode, createdAtMs: 7 },
      { code: C.shortCode, market: 'KR', name: '기존 C', standardCode: C.standardCode, createdAtMs: 8 },
    ]);
  });

  it('현재 KRX 조회를 기다리는 동안 기존 행의 identity가 바뀌면 트랜잭션에서 다시 읽고 거부한다', async () => {
    const { service, database, universe, audit } = setup();
    database.db.insert(symbols).values({
      code: A.shortCode,
      market: 'KR',
      name: '미매핑',
      createdAtMs: 7,
    }).run();
    universe.standardCodeMap = new Map([[A.shortCode, A.standardCode]]);
    universe.onStandardCodeMap = () => {
      expect(database.sqlite.inTransaction).toBe(false);
      database.db.update(symbols)
        .set({ standardCode: 'KR7-CONCURRENT-CONFLICT' })
        .run();
    };

    await expect(manual(service, [A.standardCode]))
      .rejects.toBeInstanceOf(SymbolIdentityConflictError);

    expect(universe.standardCodeMapCalls).toBe(1);
    expect(database.db.select().from(symbols).all()[0]?.standardCode)
      .toBe('KR7-CONCURRENT-CONFLICT');
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('검증된 null 표준코드 백필이 정확히 한 행을 바꾸지 못하면 스냅샷을 만들지 않는다', async () => {
    const { service, database, universe, audit } = setup();
    database.db.insert(symbols).values({
      code: A.shortCode,
      market: 'KR',
      name: '미매핑',
      createdAtMs: 7,
    }).run();
    universe.standardCodeMap = new Map([[A.shortCode, A.standardCode]]);
    database.sqlite.exec(`
      CREATE TRIGGER ignore_standard_code_backfill
      BEFORE UPDATE OF standard_code ON symbols
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    await expect(manual(service, [A.standardCode]))
      .rejects.toBeInstanceOf(SymbolIdentityConflictError);

    expect(database.db.select().from(symbols).all()[0]?.standardCode).toBeNull();
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it.each([
    ['현재 맵에 없음', new Map<string, string>()],
    ['현재 맵과 불일치', new Map([[A.shortCode, 'KR7-CURRENTLY-DIFFERENT']])],
  ])('기존 미매핑 행을 %s 상태에서는 병합하지 않는다', async (_label, currentMap) => {
    const { service, database, universe } = setup();
    database.db.insert(symbols).values({
      code: A.shortCode,
      market: 'KR',
      name: '미매핑',
      createdAtMs: 7,
    }).run();
    universe.standardCodeMap = currentMap;

    await expect(manual(service, [A.standardCode]))
      .rejects.toBeInstanceOf(SymbolIdentityConflictError);

    expect(universe.standardCodeMapCalls).toBe(1);
    expect(database.db.select().from(symbols).all()[0]?.standardCode).toBeNull();
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
  });

  it('symbols 등록·백필·스냅샷·값 행 쓰기는 하나의 트랜잭션이라 중간 실패를 전부 롤백한다', async () => {
    const { service, database, audit } = setup();
    database.sqlite.exec(`
      CREATE TRIGGER force_snapshot_symbol_failure
      BEFORE INSERT ON universe_snapshot_symbols
      BEGIN
        SELECT RAISE(ABORT, 'forced snapshot-symbol failure');
      END
    `);

    await expect(manual(service, [A.standardCode])).rejects.toThrow('forced snapshot-symbol failure');

    expect(database.db.select().from(symbols).all()).toEqual([]);
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
    expect(database.db.select().from(universeSnapshotSymbols).all()).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it.each(['code', 'standard_code'])('symbols.%s unique 충돌은 identity 오류로 번역하고 전체를 롤백한다', async (column) => {
    const { service, database, audit } = setup();
    database.sqlite.exec(`
      CREATE TRIGGER force_symbol_identity_unique
      BEFORE INSERT ON symbols
      BEGIN
        SELECT RAISE(ABORT, 'UNIQUE constraint failed: symbols.${column}');
      END
    `);

    await expect(manual(service, [A.standardCode]))
      .rejects.toBeInstanceOf(SymbolIdentityConflictError);

    expect(database.db.select().from(symbols).all()).toEqual([]);
    expect(database.db.select().from(universeSnapshots).all()).toEqual([]);
    expect(database.db.select().from(universeSnapshotSymbols).all()).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('모든 provenance 필드와 당시 종목 값을 원문 손실 없이 저장하고 DTO 경계에서 문자열로 돌려준다', async () => {
    const { service, database } = setup(previewOf([A, B, UNKNOWN]));

    const detail = await manual(service, [UNKNOWN.standardCode, A.standardCode]);

    expect(detail).toMatchObject({
      sourceKind: 'KRX_HISTORICAL',
      requestedDate: '2025-01-04',
      effectiveTradingDate: '2025-01-02',
      usableFromDate: '2025-01-03',
      selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
      selectionN: null,
      selectedCount: 2,
      unknownMarketCapCount: 1,
      createdAtMs: 1_000,
      krxApprovalExpiryDate: '2027-12-31',
      symbols: [
        {
          standardCode: A.standardCode,
          shortCode: A.shortCode,
          name: A.name,
          market: A.market,
          marketCapKrw: '300',
          rank: 1,
        },
        {
          standardCode: UNKNOWN.standardCode,
          shortCode: UNKNOWN.shortCode,
          name: UNKNOWN.name,
          market: UNKNOWN.market,
          marketCapKrw: null,
          rank: null,
        },
      ],
    });
    expect(database.db.select().from(universeSnapshots).all()[0]).toMatchObject({
      sourceKind: 'KRX_HISTORICAL',
      requestedDate: '2025-01-04',
      effectiveTradingDate: '2025-01-02',
      usableFromDate: '2025-01-03',
      usableFromRule: 'NEXT_SESSION_CONSERVATIVE_V1',
      marketsJson: '["KOSPI","KOSDAQ"]',
      filterPolicyVersion: 'krx-common-stock-v1',
      contractVersion: 'v1',
      sortKey: 'MKTCAP',
      sortDirection: 'DESC',
      selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
      selectionN: null,
      selectedCount: 2,
      eligibleCount: 3,
      unknownMarketCapCount: 1,
      excludedByTypeJson: '{"NON_STOCK_SECURITY":2,"PREFERRED_STOCK":1}',
      rawCountsJson: '{"KOSPI":4,"KOSDAQ":3}',
      candidateCanonicalHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      krxApprovalExpiryDate: '2027-12-31',
      createdAtMs: 1_000,
    });
    expect(database.db.select().from(universeSnapshotSymbols).all()).toEqual([
      {
        id: 1,
        snapshotId: detail.id,
        standardCode: A.standardCode,
        shortCode: A.shortCode,
        nameAtSelection: A.name,
        marketAtSelection: A.market,
        marketCapKrw: '300',
        rank: 1,
        instrumentType: 'COMMON_STOCK',
      },
      {
        id: 2,
        snapshotId: detail.id,
        standardCode: UNKNOWN.standardCode,
        shortCode: UNKNOWN.shortCode,
        nameAtSelection: UNKNOWN.name,
        marketAtSelection: UNKNOWN.market,
        marketCapKrw: null,
        rank: null,
        instrumentType: 'COMMON_STOCK',
      },
    ]);
  });

  it('selectionHash는 selectionPayloadOf의 SHA-256이고 선택 입력 순서와 무관하다', async () => {
    const { service, database, preview } = setup();
    const expected = createHash('sha256')
      .update(selectionPayloadOf(preview!.set.canonicalPayload, [C.standardCode, A.standardCode]))
      .digest('hex');

    await manual(service, [C.standardCode, A.standardCode]);
    await manual(service, [A.standardCode, C.standardCode]);

    const rows = database.db.select().from(universeSnapshots).all();
    expect(rows.map((row) => row.selectionHash)).toEqual([expected, expected]);
  });

  it('감사 기록은 커밋이 끝난 뒤 정확히 한 번 남고 필수 detail을 담는다', async () => {
    const { service, database, audit } = setup();
    audit.onRecord = () => {
      expect(database.sqlite.inTransaction).toBe(false);
      expect(database.db.select().from(universeSnapshots).all()).toHaveLength(1);
      expect(database.db.select().from(universeSnapshotSymbols).all()).toHaveLength(2);
    };

    const detail = await manual(service, [A.standardCode, B.standardCode]);

    expect(audit.events).toEqual([{
      actor: 'system',
      event: 'universe.snapshot.created',
      detail: {
        snapshotId: detail.id,
        effectiveTradingDate: '2025-01-02',
        selectedCount: 2,
        selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
      },
    }]);
  });

  it('커밋 뒤 audit.record가 기록 후 throw해도 저장 결과를 반환하고 재시도 오류를 만들지 않는다', async () => {
    const { service, database, audit } = setup();
    audit.errorAfterRecord = new Error('audit storage unavailable after recording');

    const detail = await manual(service, [A.standardCode]);

    expect(detail.symbols).toHaveLength(1);
    expect(database.db.select().from(universeSnapshots).all()).toHaveLength(1);
    expect(audit.events).toHaveLength(1);
  });

  it('audit 실패를 기록하는 logger.error도 throw하면 삼키고 이미 커밋한 결과를 반환한다', async () => {
    let errorCalls = 0;
    const throwingLogger = {
      debug() {},
      info() { throw new Error('duplicate success logger must not run'); },
      warn() {},
      error() {
        errorCalls += 1;
        throw new Error('logger unavailable');
      },
    } as unknown as Logger;
    const { service, database, audit } = setup(previewOf(), { logger: throwingLogger });
    audit.errorAfterRecord = new Error('audit unavailable');

    const detail = await manual(service, [A.standardCode]);

    expect(detail.symbols).toHaveLength(1);
    expect(database.db.select().from(universeSnapshots).all()).toHaveLength(1);
    expect(audit.events).toHaveLength(1);
    expect(errorCalls).toBe(1);
  });

  it('정상 audit 뒤 별도 성공 logger를 호출하지 않는다', async () => {
    const throwingSuccessLogger = {
      debug() {},
      info() { throw new Error('duplicate success logger must not run'); },
      warn() {},
      error() {},
    } as unknown as Logger;
    const { service, database, audit } = setup(previewOf(), { logger: throwingSuccessLogger });

    const detail = await manual(service, [A.standardCode]);

    expect(detail.symbols).toHaveLength(1);
    expect(database.db.select().from(universeSnapshots).all()).toHaveLength(1);
    expect(audit.events).toHaveLength(1);
  });

  it('getSnapshot과 listSnapshots은 DB 값에서 불변 DTO를 재구성하고 최신순·id 역순으로 정렬한다', async () => {
    const { service, clock, preview } = setup(previewOf([{ ...A }, { ...B }, { ...C }]));
    const originalName = A.name;
    const first = await manual(service, [A.standardCode]);
    clock.set(2_000);
    const second = await manual(service, [B.standardCode]);
    const third = await manual(service, [C.standardCode]);

    (first.symbols[0] as { name: string }).name = '호출자가 바꾼 이름';
    (preview!.set.candidates[0] as { name: string }).name = '캐시가 바뀐 이름';

    expect(service.getSnapshot(first.id)?.symbols[0]?.name).toBe(originalName);
    expect(service.getSnapshot('usn_missing')).toBeNull();
    const sameTimeNewest = [second.id, third.id].sort().reverse();
    expect(service.listSnapshots().map((item) => item.id)).toEqual([...sameTimeNewest, first.id]);

    const listed = service.listSnapshots();
    (listed[0] as { selectedCount: number }).selectedCount = 999;
    expect(service.listSnapshots()[0]?.selectedCount).toBe(1);
  });
});
