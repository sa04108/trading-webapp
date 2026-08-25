import { describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  dailySelectionMetrics,
  symbolMasterCoverage,
  symbolMasterTradingDays,
  symbolMasterVersions,
} from '../../src/server/shared/db/schema.js';
import type { KrxHistoricalUniverseSource } from '../../src/server/modules/market-data/application/ports.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import type { SymbolMasterEntry } from '../../src/server/modules/market-data/domain/symbol-master.js';

function entry(overrides: Partial<SymbolMasterEntry> = {}): SymbolMasterEntry {
  return {
    standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자',
    market: 'KOSPI', sharesOutstanding: '100', instrumentType: 'COMMON_STOCK',
    listedDate: '1975-06-11', ...overrides,
  };
}

// 이 태스크는 source 를 쓰지 않는다 (다음 태스크가 실제 KRX 조회에 쓴다) — 더미로 충분하다.
const DUMMY_SOURCE = {} as unknown as KrxHistoricalUniverseSource;

function makeService(t: TestApp): SymbolMasterService {
  const deps: SymbolMasterServiceDeps = {
    db: t.container.database.db,
    source: DUMMY_SOURCE,
    clock: t.container.clock,
    logger: t.container.logger,
  };
  return new SymbolMasterService(deps);
}

function insertVersion(
  t: TestApp,
  value: SymbolMasterEntry,
  validFromDate: string,
  validToDate: string | null,
): void {
  t.container.database.db.insert(symbolMasterVersions).values({
    standardCode: value.standardCode,
    validFromDate,
    validToDate,
    shortCode: value.shortCode,
    name: value.name,
    market: value.market,
    sharesOutstanding: value.sharesOutstanding,
    instrumentType: value.instrumentType,
    listedDate: value.listedDate,
    recordedAtMs: t.container.clock.now(),
  }).run();
}

describe('getUniverseAsOf', () => {
  it('validToDate는 미포함이고 같은 날 시작하는 새 버전은 포함한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2023-01-01', '2023-12-31');
    insertVersion(t, entry(), '2023-01-02', '2023-02-01');
    insertVersion(t, entry({ sharesOutstanding: '150' }), '2023-02-01', null);

    expect(svc.getUniverseAsOf('2023-01-31').get('KR7005930003')?.sharesOutstanding)
      .toBe('100');
    expect(svc.getUniverseAsOf('2023-02-01').get('KR7005930003')?.sharesOutstanding)
      .toBe('150');
    await t.close();
  });

  it('폐지일에는 validToDate가 끝난 종목을 유니버스에서 제외한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2023-01-01', '2023-12-31');
    insertVersion(t, entry(), '2023-01-02', '2023-02-01');

    expect(svc.getUniverseAsOf('2023-01-31').has('KR7005930003')).toBe(true);
    expect(svc.getUniverseAsOf('2023-02-01').has('KR7005930003')).toBe(false);
    await t.close();
  });

  it('폐지 후 재상장하면 부재 구간 뒤의 새 버전만 다시 노출한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2023-01-01', '2023-12-31');
    insertVersion(t, entry(), '2023-01-02', '2023-02-01');
    insertVersion(
      t,
      entry({ shortCode: '005931', name: '삼성전자 재상장' }),
      '2023-03-01',
      null,
    );

    expect(svc.getUniverseAsOf('2023-02-15').has('KR7005930003')).toBe(false);
    expect(svc.getUniverseAsOf('2023-03-01').get('KR7005930003')).toMatchObject({
      shortCode: '005931',
      name: '삼성전자 재상장',
    });
    expect(svc.listEvents('2023-02-01', '2023-03-01').map((event) => event.eventType)).toEqual([
      'DELISTED',
      'LISTED',
    ]);
    await t.close();
  });
});

describe('SymbolMasterService.ingestDate selection metrics', () => {
  it('daily trade 의 cap·volume·거래대금을 표준코드 metric 으로 같은 ingest transaction 에 저장한다', async () => {
    const t = await createTestApp();
    const source: KrxHistoricalUniverseSource = {
      async fetchDailyTrades(market) {
        if (market === 'KOSDAQ') return [];
        return [{
          shortCode: '005930', name: '삼성전자', marketCapRaw: '350000000000000',
          open: 71_500, high: 72_000, low: 71_000, close: 71_800, volume: 12_345_678,
          tradingValueRaw: '123456789012345',
        }];
      },
      async fetchIssueBaseInfo(market) {
        if (market === 'KOSDAQ') return [];
        return [{
          standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자',
          listedDate: '1975-06-11', marketRaw: 'KOSPI', securityGroupRaw: '주권',
          sectionRaw: '대형주', stockKindRaw: '보통주', listedShares: '100',
        }];
      },
      todayMaxEndpointCallCount() { return 0; },
    };
    const svc = new SymbolMasterService({
      db: t.container.database.db, source, clock: t.container.clock, logger: t.container.logger,
    });

    await svc.ingestDate('2026-08-07');

    expect(t.container.database.db.select().from(dailySelectionMetrics).all()).toEqual([{
      date: '2026-08-07', standardCode: 'KR7005930003', marketCapKrw: '350000000000000',
      volume: 12_345_678, tradingValueKrw: '123456789012345',
    }]);
    await t.close();
  });
});

function insertCoverage(t: TestApp, startDate: string, endDate: string): void {
  t.container.database.db
    .insert(symbolMasterCoverage)
    .values({ startDate, endDate, syncedAtMs: t.container.clock.now() })
    .run();
  let firstWeekdayTsMs = Date.parse(`${startDate}T00:00:00Z`);
  while ([0, 6].includes(new Date(firstWeekdayTsMs).getUTCDay())) {
    firstWeekdayTsMs += 86_400_000;
  }
  const firstWeekday = new Date(firstWeekdayTsMs).toISOString().slice(0, 10);
  if (firstWeekday <= endDate) {
    t.container.database.db
      .insert(symbolMasterTradingDays)
      .values({ date: firstWeekday })
      .onConflictDoNothing()
      .run();
  }
}

/**
 * 운영에서 확인된 버그의 정확한 재현 조건 — 리밸런스 날짜만 개별 동기화되면
 * `isCovered(rebalanceDate)` 는 날짜마다 참이지만, 그 사이 평일은 여전히
 * coverage 밖이다. `uncoveredDates`(리밸런스 날짜 게이트)는 이 틈을 못 보므로
 * "기간 전체 동기화" 버튼이 사라지고, 남은 유일한 해결책처럼 보이는 증권사
 * 동기화가 상장폐지 종목에서 404 로 실패했다 — `isRangeCovered` 가 이 틈을
 * 직접 잡아야 한다.
 */
describe('SymbolMasterService.isRangeCovered', () => {
  it('구간 전체를 덮는 커버 구간 하나면 true 다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2026-01-01', '2026-03-31');

    expect(svc.isRangeCovered('2026-01-05', '2026-03-05')).toBe(true);
    await t.close();
  });

  it('경계가 정확히 일치해도 true 다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2026-01-05', '2026-03-05');

    expect(svc.isRangeCovered('2026-01-05', '2026-03-05')).toBe(true);
    await t.close();
  });

  it('리밸런스 날짜만 커버되고 그 사이가 비어 있으면 false 다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    // 리밸런스 날짜 3개만 하루짜리 구간으로 개별 동기화된 상태 — 그 사이 평일은
    // 어느 구간에도 없다.
    insertCoverage(t, '2026-01-05', '2026-01-05');
    insertCoverage(t, '2026-02-05', '2026-02-05');
    insertCoverage(t, '2026-03-05', '2026-03-05');

    expect(svc.isRangeCovered('2026-01-05', '2026-03-05')).toBe(false);
    await t.close();
  });

  it('구간 앞부분이 비어 있으면 false 다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2026-02-01', '2026-03-31');

    expect(svc.isRangeCovered('2026-01-05', '2026-03-05')).toBe(false);
    await t.close();
  });

  it('구간 뒷부분이 비어 있으면 false 다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2026-01-01', '2026-02-01');

    expect(svc.isRangeCovered('2026-01-05', '2026-03-05')).toBe(false);
    await t.close();
  });

  it('커버 구간이 아예 없으면 false 다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);

    expect(svc.isRangeCovered('2026-01-05', '2026-03-05')).toBe(false);
    await t.close();
  });

  it('서로 하루 간격으로 이어 붙는 여러 구간이 합쳐서 덮으면 true 다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    // mergeCoverage 를 거치지 않고 인접한 두 구간을 직접 넣는다 — isRangeCovered
    // 는 저장 방식과 무관하게 이 자체로도 판정할 수 있어야 한다.
    insertCoverage(t, '2026-01-05', '2026-02-04');
    insertCoverage(t, '2026-02-05', '2026-03-05');

    expect(svc.isRangeCovered('2026-01-05', '2026-03-05')).toBe(true);
    await t.close();
  });
});

/**
 * DELISTED 이벤트는 `symbol_master_versions` 의 버전 경계를 비교해 파생한다.
 * 각 테스트는 경계일 앞의 관측 거래일을 coverage와 함께 심는다.
 */
describe('SymbolMasterService.delistedEventsBetween', () => {
  it('DELISTED 이벤트의 oldValue 에서 shortCode 를 꺼낸다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2020-01-01', '2026-12-31');
    insertVersion(
      t,
      entry({ standardCode: 'KR7000660001', shortCode: '000660' }),
      '2020-01-01',
      '2026-03-10',
    );

    const rows = svc.delistedEventsBetween('2026-01-01', '2026-12-31');

    expect(rows).toEqual([{ shortCode: '000660', effectiveDate: '2026-03-10' }]);
    await t.close();
  });

  it('DELISTED 가 아닌 이벤트는 제외한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2020-01-01', '2026-12-31');
    // 같은 종목이 폐지 없이 유통주식수만 바뀌는 경계 — SHARES_CHANGED 로 파생되고
    // DELISTED 가 아니므로 걸러져야 한다.
    insertVersion(
      t,
      entry({ standardCode: 'KR7005930003', sharesOutstanding: '100' }),
      '2020-01-01',
      '2026-03-10',
    );
    insertVersion(
      t,
      entry({ standardCode: 'KR7005930003', sharesOutstanding: '90' }),
      '2026-03-10',
      null,
    );

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([]);
    await t.close();
  });

  it('구간 밖에서 폐지된 종목은 제외한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2020-01-01', '2026-12-31');
    insertVersion(
      t,
      entry({ standardCode: 'KR7000660001', shortCode: '000660' }),
      '2020-01-01',
      '2025-12-31',
    );

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([]);
    await t.close();
  });

  it('하루 빠졌다 돌아온 종목은 폐지로 보고하지 않고, 돌아오지 않은 종목만 보고한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2020-01-01', '2026-12-31');
    // 000660 은 KRX 기초정보 응답에서 하루(2026-03-10) 빠졌다가 다음 날 돌아왔다 —
    // persistTradingDay 가 구간을 닫고 새로 열어 DELISTED + LISTED 로 파생된다.
    insertVersion(
      t,
      entry({ standardCode: 'KR7000660001', shortCode: '000660' }),
      '2020-01-01',
      '2026-03-10',
    );
    insertVersion(
      t,
      entry({ standardCode: 'KR7000660001', shortCode: '000660' }),
      '2026-03-11',
      null,
    );
    // 005930 은 같은 날 닫히고 돌아오지 않았다 — 진짜 폐지다
    insertVersion(
      t,
      entry({ standardCode: 'KR7005930003', shortCode: '005930' }),
      '2020-01-01',
      '2026-03-10',
    );

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([
      { shortCode: '005930', effectiveDate: '2026-03-10' },
    ]);
    await t.close();
  });

  it('effectiveDate 오름차순, 같은 날짜는 id(=날짜:표준코드:이벤트타입) 순서로 정렬한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertCoverage(t, '2020-01-01', '2026-12-31');
    insertVersion(
      t,
      entry({ standardCode: 'KR7005930003', shortCode: '005930' }),
      '2020-01-01',
      '2026-05-01',
    );
    insertVersion(
      t,
      entry({ standardCode: 'KR7000660001', shortCode: '000660' }),
      '2020-01-01',
      '2026-03-10',
    );
    insertVersion(
      t,
      entry({ standardCode: 'KR7900001008', shortCode: '900001' }),
      '2020-01-01',
      '2026-03-10',
    );

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([
      { shortCode: '000660', effectiveDate: '2026-03-10' },
      { shortCode: '900001', effectiveDate: '2026-03-10' },
      { shortCode: '005930', effectiveDate: '2026-05-01' },
    ]);
    await t.close();
  });

});
