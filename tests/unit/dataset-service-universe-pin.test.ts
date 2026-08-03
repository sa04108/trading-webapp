import { afterEach, describe, expect, it } from 'vitest';
import { DatasetService } from '../../src/server/modules/market-data/application/dataset-service.js';
import type { SymbolService } from '../../src/server/modules/market-data/application/symbol-service.js';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { symbols } from '../../src/server/shared/db/schema.js';
import type { AuditLogService } from '../../src/server/modules/audit/audit-service.js';

const noopAudit: AuditLogService = { record: () => {} } as unknown as AuditLogService;

function buildHarness() {
  const database = openDatabase(':memory:');
  database.db
    .insert(symbols)
    .values([
      { code: 'A', market: 'KR', name: null, createdAtMs: 1 },
      { code: 'B', market: 'KR', name: null, createdAtMs: 1 },
    ])
    .run();

  const versions = new Map([
    ['A:1d', { version: 1, contentHash: 'a-daily' }],
    ['A:facts', { version: 2, contentHash: 'a-facts' }],
    ['B:1d', { version: 3, contentHash: 'b-daily' }],
    ['B:facts', { version: 4, contentHash: 'b-facts' }],
  ]);
  const symbolService = {
    getLatestVersion: (code: string, slice: string) => versions.get(`${code}:${slice}`) ?? null,
  } as unknown as SymbolService;
  const service = new DatasetService(database.db, symbolService, { now: () => 1 }, noopAudit);
  const dataset = service.createDataset('pair', ['A', 'B']);
  return { database, dataset, service, versions };
}

describe('DatasetService universe pin', () => {
  const databases: DatabaseHandle[] = [];

  function setup() {
    const harness = buildHarness();
    databases.push(harness.database);
    return harness;
  }

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('요청 종목 부분집합만 pin 한다 — 데이터셋의 다른 종목은 해시에 들어가지 않는다', () => {
    const { dataset, service, versions } = setup();
    expect(dataset.symbols).toEqual(['A', 'B']);

    const subset = service.universeSnapshotFor(['A'], '1d');
    expect(subset.entries.map((entry) => entry.code)).toEqual(['A', 'A']);
    expect(subset.hash).not.toBe(service.universeSnapshot(dataset.id, '1d').hash);

    versions.set('B:1d', { version: 30, contentHash: 'b-daily-changed' });
    expect(service.universeSnapshotFor(['A'], '1d')).toEqual(subset);
  });

  it('전체 위임 경로는 기존과 같은 결과다', () => {
    const { dataset, service } = setup();
    expect(service.universeSnapshot(dataset.id, '1d')).toEqual(
      service.universeSnapshotFor(dataset.symbols, '1d'),
    );
  });

  it('요청 순서와 중복에 관계없이 같은 종목 집합을 결정적으로 pin 한다', () => {
    const { service } = setup();
    const canonical = service.universeSnapshotFor(['A', 'B'], '1d');
    expect(service.universeSnapshotFor(['B', 'A'], '1d')).toEqual(canonical);
    expect(service.universeSnapshotFor(['B', 'A', 'B'], '1d')).toEqual(canonical);
  });
});
