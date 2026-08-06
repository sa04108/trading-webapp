import { afterEach, describe, expect, it } from 'vitest';
import { SymbolService } from '../../src/server/modules/market-data/application/symbol-service.js';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { symbols, symbolVersions } from '../../src/server/shared/db/schema.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import type { AuditLogService } from '../../src/server/modules/audit/audit-service.js';
import type { CandleRepository } from '../../src/server/modules/market-data/application/ports.js';

const noopAudit: AuditLogService = { record: () => {} } as unknown as AuditLogService;
const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));
const noopRepo = {} as unknown as CandleRepository;

function seedVersion(
  db: DatabaseHandle['db'],
  code: string,
  slice: string,
  version: number,
  contentHash: string,
): void {
  db.insert(symbolVersions)
    .values({ id: `sv_${code}_${slice}_${version}`, code, slice, version, contentHash, createdAtMs: 1 })
    .run();
}

function buildHarness() {
  const database = openDatabase(':memory:');
  database.db
    .insert(symbols)
    .values([
      { code: 'A', market: 'KR', name: null, createdAtMs: 1 },
      { code: 'B', market: 'KR', name: null, createdAtMs: 1 },
    ])
    .run();
  seedVersion(database.db, 'A', '1d', 1, 'a-daily');
  seedVersion(database.db, 'A', 'FACTS', 2, 'a-facts');
  seedVersion(database.db, 'B', '1d', 3, 'b-daily');
  seedVersion(database.db, 'B', 'FACTS', 4, 'b-facts');
  const service = new SymbolService(database.db, noopRepo, { now: () => 1 }, logger, noopAudit);
  return { database, service };
}

/**
 * 구 `DatasetService.universeSnapshotFor` 자리 — 데이터셋 개념이 사라지면서(T6)
 * 종목 버전 pin 계산이 `SymbolService` 로 옮겼다. 데이터셋 참조를 거치지 않고
 * 요청받은 종목 코드 집합을 직접 받는다(백테스트가 유니버스 규칙으로 고른
 * unionSymbols 를 그대로 넘긴다, 스펙 2026-08-05).
 */
describe('SymbolService.versionSnapshotFor — 백테스트 버전 pin (§9.5)', () => {
  const databases: DatabaseHandle[] = [];

  function setup() {
    const harness = buildHarness();
    databases.push(harness.database);
    return harness;
  }

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('요청 종목 부분집합만 pin 한다 — 요청에 없는 종목은 해시에 들어가지 않는다', () => {
    const { database, service } = setup();

    const subset = service.versionSnapshotFor(['A'], '1d');
    expect(subset.entries.map((entry) => entry.code)).toEqual(['A', 'A']);
    expect(subset.hash).not.toBe(service.versionSnapshotFor(['A', 'B'], '1d').hash);

    // B 의 버전이 바뀌어도 A 만 요청한 pin 은 그대로다
    database.db
      .insert(symbolVersions)
      .values({ id: 'sv_B_1d_30', code: 'B', slice: '1d', version: 30, contentHash: 'b-daily-changed', createdAtMs: 2 })
      .run();
    expect(service.versionSnapshotFor(['A'], '1d')).toEqual(subset);
  });

  it('요청 순서와 중복에 관계없이 같은 종목 집합을 결정적으로 pin 한다', () => {
    const { service } = setup();
    const canonical = service.versionSnapshotFor(['A', 'B'], '1d');
    expect(service.versionSnapshotFor(['B', 'A'], '1d')).toEqual(canonical);
    expect(service.versionSnapshotFor(['B', 'A', 'B'], '1d')).toEqual(canonical);
  });

  it('버전이 없는 조합은 version 0·빈 해시로 남는다 — "아직 수집 안 됨" 도 입력 상태다', () => {
    const { service } = setup();
    const snapshot = service.versionSnapshotFor(['C'], '1d');
    expect(snapshot.entries).toEqual([
      { code: 'C', slice: '1d', version: 0, contentHash: '' },
      { code: 'C', slice: 'FACTS', version: 0, contentHash: '' },
    ]);
  });
});
