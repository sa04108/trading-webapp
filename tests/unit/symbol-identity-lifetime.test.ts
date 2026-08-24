import { describe, expect, it } from 'vitest';
import {
  facts,
  krxDailyBars,
  symbolMasterVersions,
  symbols,
} from '../../src/server/shared/db/schema.js';
import type { SymbolIdentitySelection } from '../../src/server/modules/market-data/domain/symbol-identity-lifetime.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

interface VersionInput {
  readonly standardCode: string;
  readonly shortCode: string;
  readonly validFromDate: string;
  readonly validToDate: string | null;
  readonly name?: string;
}

function insertVersion(t: TestApp, version: VersionInput): void {
  t.container.database.db.insert(symbolMasterVersions).values({
    ...version,
    name: version.name ?? version.standardCode,
    market: 'KOSPI',
    sharesOutstanding: '100',
    instrumentType: 'COMMON_STOCK',
    listedDate: version.validFromDate,
    recordedAtMs: t.container.clock.now(),
  }).run();
}

describe('SymbolMasterService.validateIdentityLifetime', () => {
  it('선택 pair와 알려진 전체 생애가 1:1이면 안전하다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2000-01-01', validToDate: null,
    });

    expect(t.container.symbolMasterService.validateIdentityLifetime([{
      standardCode: 'KR7000000001', shortCode: '000001', effectiveDate: '2020-01-02',
    }])).toEqual({ safe: true, conflicts: [] });
    await t.close();
  });

  it('SCD 역방향 alias와 현재 등록 owner를 한 identity snapshot에 담는다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000002',
      validFromDate: '1990-01-01', validToDate: '2000-01-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2000-01-01', validToDate: null,
    });
    t.container.database.db.insert(symbols).values([{
      code: '000001', market: 'KR', name: '선택 코드', standardCode: null,
      createdAtMs: t.container.clock.now(),
    }, {
      code: '000002', market: 'KR', name: '등록 owner', standardCode: 'KR7000000001',
      createdAtMs: t.container.clock.now(),
    }]).run();

    const snapshot = t.container.symbolMasterService.readIdentitySnapshot(
      ['000001'],
      ['KR7000000001'],
    );

    expect(snapshot.versions.map(({ shortCode }) => shortCode).sort())
      .toEqual(['000001', '000002']);
    expect(snapshot.registrations).toEqual([
      { code: '000001', standardCode: null },
      { code: '000002', standardCode: 'KR7000000001' },
    ]);
    await t.close();
  });

  it('미등록 shortCode의 orphan fact와 SCD 구간 밖 봉을 snapshot에서 찾는다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2020-01-01', validToDate: null,
    });
    t.container.database.db.insert(facts).values({
      scope: 'SYMBOL',
      key: '000001',
      field: 'PER',
      periodKey: '2019',
      asOfTsMs: 1,
      value: 1,
      unit: 'RATIO',
    }).run();
    t.container.database.db.insert(krxDailyBars).values([{
      shortCode: '000001', date: '2019-12-30', market: 'KOSPI',
      open: 10, high: 11, low: 9, close: 10, volume: 100,
    }, {
      shortCode: '000001', date: '2025-01-02', market: 'KOSPI',
      open: 100, high: 101, low: 99, close: 100, volume: 1_000,
    }]).run();

    const snapshot = t.container.symbolMasterService.readIdentitySnapshot(
      ['000001'],
      ['KR7000000001'],
    );

    expect(snapshot.registrations).toEqual([]);
    expect(snapshot.unregisteredFactShortCodes).toEqual(['000001']);
    expect(snapshot.uncoveredBarShortCodes).toEqual(['000001']);
    await t.close();
  });

  it('이미 정확히 등록된 shortCode도 SCD 구간 밖의 과거 봉을 숨기지 않는다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2020-01-01', validToDate: null,
    });
    t.container.database.db.insert(symbols).values({
      code: '000001', market: 'KR', name: '현재 발행사', standardCode: 'KR7000000001',
      createdAtMs: t.container.clock.now(),
    }).run();
    t.container.database.db.insert(krxDailyBars).values({
      shortCode: '000001', date: '2019-12-30', market: 'KOSPI',
      open: 10, high: 11, low: 9, close: 10, volume: 100,
    }).run();

    const snapshot = t.container.symbolMasterService.readIdentitySnapshot(
      ['000001'],
      ['KR7000000001'],
    );

    expect(snapshot.registrations).toEqual([{
      code: '000001', standardCode: 'KR7000000001',
    }]);
    expect(snapshot.uncoveredBarShortCodes).toEqual(['000001']);
    await t.close();
  });

  it('같은 exact pair가 다시 열린 내부 SCD gap의 봉은 base-info 일시 결측으로 본다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2020-01-01', validToDate: '2025-01-02',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2025-01-03', validToDate: null,
    });
    t.container.database.db.insert(symbols).values({
      code: '000001', market: 'KR', name: '동일 발행사', standardCode: 'KR7000000001',
      createdAtMs: t.container.clock.now(),
    }).run();
    t.container.database.db.insert(krxDailyBars).values({
      shortCode: '000001', date: '2025-01-02', market: 'KOSPI',
      open: 100, high: 101, low: 99, close: 100, volume: 1_000,
    }).run();

    const snapshot = t.container.symbolMasterService.readIdentitySnapshot(
      ['000001'],
      ['KR7000000001'],
    );

    expect(snapshot.uncoveredBarShortCodes).toEqual([]);
    await t.close();
  });

  it('먼 미래에 같은 pair가 돌아와도 중간의 다른 pair 앞 gap 봉은 숨기지 않는다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2020-01-01', validToDate: '2020-02-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000002', shortCode: '000001',
      validFromDate: '2020-02-10', validToDate: '2020-03-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2020-04-01', validToDate: null,
    });
    t.container.database.db.insert(symbols).values({
      code: '000001', market: 'KR', name: '현재 발행사', standardCode: 'KR7000000001',
      createdAtMs: t.container.clock.now(),
    }).run();
    t.container.database.db.insert(krxDailyBars).values({
      shortCode: '000001', date: '2020-02-05', market: 'KOSPI',
      open: 100, high: 101, low: 99, close: 100, volume: 1_000,
    }).run();

    const snapshot = t.container.symbolMasterService.readIdentitySnapshot(
      ['000001'],
      ['KR7000000001'],
    );

    expect(snapshot.uncoveredBarShortCodes).toEqual(['000001']);
    await t.close();
  });

  it('선택 기간 밖의 과거 발행사까지 읽어 단축코드 재사용을 탐지한다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000002', shortCode: '000001',
      validFromDate: '1990-01-01', validToDate: '2000-01-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2020-01-01', validToDate: null,
    });

    expect(t.container.symbolMasterService.validateIdentityLifetime([{
      standardCode: 'KR7000000001', shortCode: '000001', effectiveDate: '2024-01-02',
    }])).toEqual({
      safe: false,
      conflicts: [{
        kind: 'SHORT_CODE_REUSED',
        shortCode: '000001',
        standardCodes: ['KR7000000001', 'KR7000000002'],
      }],
    });
    await t.close();
  });

  it('표준코드가 생애 중 여러 단축코드에 연결된 경우도 탐지한다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000002',
      validFromDate: '2000-01-01', validToDate: '2010-01-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2010-01-01', validToDate: null,
    });

    expect(t.container.symbolMasterService.validateIdentityLifetime([{
      standardCode: 'KR7000000001', shortCode: '000001', effectiveDate: '2021-01-04',
    }])).toEqual({
      safe: false,
      conflicts: [{
        kind: 'STANDARD_CODE_REASSIGNED',
        standardCode: 'KR7000000001',
        shortCodes: ['000001', '000002'],
      }],
    });
    await t.close();
  });

  it('effectiveDate에 정확한 pair가 없으면 당시 실제 pair와 함께 보고한다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2000-01-01', validToDate: '2020-01-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000002',
      validFromDate: '2020-01-01', validToDate: null,
    });

    expect(t.container.symbolMasterService.validateIdentityLifetime([{
      standardCode: 'KR7000000001', shortCode: '000001', effectiveDate: '2021-05-03',
    }])).toEqual({
      safe: false,
      conflicts: [
        {
          kind: 'STANDARD_CODE_REASSIGNED',
          standardCode: 'KR7000000001',
          shortCodes: ['000001', '000002'],
        },
        {
          kind: 'PAIR_NOT_EFFECTIVE',
          standardCode: 'KR7000000001',
          shortCode: '000001',
          effectiveDate: '2021-05-03',
          activePairs: [{ standardCode: 'KR7000000001', shortCode: '000002' }],
        },
      ],
    });
    await t.close();
  });

  it('동일 pair의 메타데이터 버전과 폐지 후 재개는 허용한다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001', name: '과거 이름',
      validFromDate: '2000-01-01', validToDate: '2010-01-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001', name: '현재 이름',
      validFromDate: '2010-01-01', validToDate: '2020-01-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001', name: '재개 이름',
      validFromDate: '2021-01-01', validToDate: null,
    });

    expect(t.container.symbolMasterService.validateIdentityLifetime([
      { standardCode: 'KR7000000001', shortCode: '000001', effectiveDate: '2005-01-03' },
      { standardCode: 'KR7000000001', shortCode: '000001', effectiveDate: '2022-01-03' },
    ])).toEqual({ safe: true, conflicts: [] });
    await t.close();
  });

  it('500개를 넘는 양쪽 key도 batch 조회한다', async () => {
    const t = await createTestApp();
    const selections: SymbolIdentitySelection[] = Array.from({ length: 501 }, (_, index) => ({
      shortCode: String(index).padStart(6, '0'),
      standardCode: `KR7${String(index).padStart(9, '0')}`,
      effectiveDate: '2024-01-02',
    }));
    const last = selections[500]!;
    t.container.database.db.insert(symbolMasterVersions).values(selections.map((selection) => ({
      standardCode: selection.standardCode,
      shortCode: selection.shortCode,
      validFromDate: '2000-01-01',
      validToDate: null,
      name: selection.standardCode,
      market: 'KOSPI',
      sharesOutstanding: '100',
      instrumentType: 'COMMON_STOCK',
      listedDate: '2000-01-01',
      recordedAtMs: t.container.clock.now(),
    }))).run();
    // 둘 다 두 번째 chunk에서만 찾을 수 있다. 첫 행은 shortCode 조회, 둘째 행은
    // standardCode 조회가 빠지면 각각의 충돌이 사라져 테스트가 실패한다.
    insertVersion(t, {
      standardCode: 'KR7999999998', shortCode: last.shortCode,
      validFromDate: '1990-01-01', validToDate: '2000-01-01',
    });
    insertVersion(t, {
      standardCode: last.standardCode, shortCode: '999999',
      validFromDate: '1990-01-01', validToDate: '2000-01-01',
    });

    expect(t.container.symbolMasterService.validateIdentityLifetime(selections))
      .toEqual({
        safe: false,
        conflicts: [
          {
            kind: 'SHORT_CODE_REUSED',
            shortCode: last.shortCode,
            standardCodes: [last.standardCode, 'KR7999999998'].sort(),
          },
          {
            kind: 'STANDARD_CODE_REASSIGNED',
            standardCode: last.standardCode,
            shortCodes: [last.shortCode, '999999'].sort(),
          },
        ],
      });
    await t.close();
  });

  it('legacy 단축코드는 전체 생애가 양방향 1:1일 때만 추론한다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2000-01-01', validToDate: '2010-01-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2020-01-01', validToDate: null,
    });

    expect(t.container.symbolMasterService.inferUniqueLifetimeIdentities([
      '000001', '000001',
    ])).toEqual({
      safe: true,
      identities: [{ standardCode: 'KR7000000001', shortCode: '000001' }],
      conflicts: [],
    });
    await t.close();
  });

  it('legacy 추론은 재사용·반대방향 변경·unknown을 구조적으로 보고한다', async () => {
    const t = await createTestApp();
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000002',
      validFromDate: '1990-01-01', validToDate: '2000-01-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000001', shortCode: '000001',
      validFromDate: '2000-01-01', validToDate: '2010-01-01',
    });
    insertVersion(t, {
      standardCode: 'KR7000000002', shortCode: '000001',
      validFromDate: '2010-01-01', validToDate: null,
    });

    expect(t.container.symbolMasterService.inferUniqueLifetimeIdentities([
      '999999', '000001',
    ])).toEqual({
      safe: false,
      identities: [],
      conflicts: [
        {
          kind: 'SHORT_CODE_REUSED',
          shortCode: '000001',
          standardCodes: ['KR7000000001', 'KR7000000002'],
        },
        {
          kind: 'STANDARD_CODE_REASSIGNED',
          standardCode: 'KR7000000001',
          shortCodes: ['000001', '000002'],
        },
        { kind: 'SHORT_CODE_UNKNOWN', shortCode: '999999' },
      ],
    });
    await t.close();
  });
});
