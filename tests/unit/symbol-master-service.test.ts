import { describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { symbolMasterCoverage, symbolMasterEvents } from '../../src/server/shared/db/schema.js';
import type { KrxHistoricalUniverseSource } from '../../src/server/modules/market-data/application/ports.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import type {
  SymbolMasterEntry,
  SymbolMasterEventType,
  UniverseState,
} from '../../src/server/modules/market-data/domain/symbol-master.js';

// entry()/state() 헬퍼는 diff·apply 테스트와 동일하게 정의한다
function entry(overrides: Partial<SymbolMasterEntry> = {}): SymbolMasterEntry {
  return {
    standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자',
    market: 'KOSPI', sharesOutstanding: '100', instrumentType: 'COMMON_STOCK',
    listedDate: '1975-06-11', ...overrides,
  };
}
function state(...entries: SymbolMasterEntry[]): UniverseState {
  return new Map(entries.map((e) => [e.standardCode, e]));
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

function insertEvent(t: TestApp, draft: {
  readonly effectiveDate: string;
  readonly standardCode: string;
  readonly eventType: SymbolMasterEventType;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly observedSpanStart: string;
}): void {
  t.container.database.db.insert(symbolMasterEvents).values({
    ...draft,
    createdAtMs: t.container.clock.now(),
  }).run();
}

describe('getUniverseAsOf', () => {
  it('체크포인트 이후 날짜: 순방향 이벤트 적용', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    svc.saveCheckpoint('2023-01-02', state(entry()), true);
    insertEvent(t, {
      effectiveDate: '2023-01-03', eventType: 'SHARES_CHANGED',
      standardCode: 'KR7005930003', oldValue: '"100"', newValue: '"90"',
      observedSpanStart: '2023-01-02',
    });

    expect(svc.getUniverseAsOf('2023-01-03').get('KR7005930003')!.sharesOutstanding)
      .toBe('90');
    // 이벤트 이전 날짜는 체크포인트 그대로 — (cp, date] 구간에 이벤트가 없다
    expect(svc.getUniverseAsOf('2023-01-02').get('KR7005930003')!.sharesOutstanding)
      .toBe('100');
    await t.close();
  });

  it('체크포인트 이전 날짜: 역방향 적용', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    svc.saveCheckpoint('2023-04-03', state(entry()), true);
    insertEvent(t, {
      effectiveDate: '2023-02-01', eventType: 'SHARES_CHANGED',
      standardCode: 'KR7005930003', oldValue: '"100"', newValue: '"90"',
      observedSpanStart: '2023-02-01',
    });

    // 조회일이 이벤트보다도 앞이라 (date, cp] 구간의 이벤트를 되돌려 원래 값 100 을 복원한다.
    // 방향을 거꾸로(순방향) 적용하는 버그가 있으면 90 이 나와 이 단언이 잡아낸다.
    expect(svc.getUniverseAsOf('2023-01-15').get('KR7005930003')!.sharesOutstanding)
      .toBe('100');
    await t.close();
  });

  it('가장 가까운 체크포인트를 고른다 — 두 체크포인트 사이 날짜', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    // 두 체크포인트의 값이 서로 달라야 잘못된 체크포인트를 골랐을 때 단언이 실패한다.
    svc.saveCheckpoint('2023-01-02', state(entry()), true);
    svc.saveCheckpoint('2023-04-03', state(entry({ sharesOutstanding: '999' })), true);
    insertEvent(t, {
      effectiveDate: '2023-01-10', eventType: 'SHARES_CHANGED',
      standardCode: 'KR7005930003', oldValue: '"100"', newValue: '"150"',
      observedSpanStart: '2023-01-02',
    });

    // 2023-01-20 은 1월 체크포인트(18일 차)가 4월 체크포인트(73일 차)보다 훨씬 가깝다 —
    // 1월 cp 에서 순방향으로 이벤트를 적용해 150 이 나와야 한다. 999 가 나오면 4월 cp 를
    // 잘못 골랐다는 뜻이고, 100 이 나오면 이벤트를 적용하지 않았다는 뜻이다.
    expect(svc.getUniverseAsOf('2023-01-20').get('KR7005930003')!.sharesOutstanding)
      .toBe('150');
    await t.close();
  });
});

function insertCoverage(t: TestApp, startDate: string, endDate: string): void {
  t.container.database.db
    .insert(symbolMasterCoverage)
    .values({ startDate, endDate, syncedAtMs: t.container.clock.now() })
    .run();
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
 * 워커 배선(Task 10)이 쓰는 조회 — DELISTED 이벤트의 oldValue 에서 shortCode 를
 * 꺼낸다. standardCode 만으로는 봉 심볼(단축코드)과 이어지지 않기 때문이다.
 *
 * oldValue 가 손상됐거나 shortCode 가 없는 행을 조용히 버리면 "왜 이 종목이 폐지
 * 처리되지 않았는지" 아무도 추적할 수 없다 — 그래서 그 두 경우를 각각 확인한다.
 */
describe('SymbolMasterService.delistedEventsBetween', () => {
  function delistedEvent(overrides: {
    readonly effectiveDate: string;
    readonly standardCode: string;
    readonly oldValue: string | null;
  }): Parameters<typeof insertEvent>[1] {
    return {
      effectiveDate: overrides.effectiveDate,
      standardCode: overrides.standardCode,
      eventType: 'DELISTED',
      oldValue: overrides.oldValue,
      newValue: null,
      observedSpanStart: overrides.effectiveDate,
    };
  }

  it('DELISTED 이벤트의 oldValue 에서 shortCode 를 꺼낸다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertEvent(
      t,
      delistedEvent({
        effectiveDate: '2026-03-10',
        standardCode: 'KR7000660001',
        oldValue: JSON.stringify(entry({ standardCode: 'KR7000660001', shortCode: '000660' })),
      }),
    );

    const rows = svc.delistedEventsBetween('2026-01-01', '2026-12-31');

    expect(rows).toEqual([{ shortCode: '000660', effectiveDate: '2026-03-10' }]);
    await t.close();
  });

  it('DELISTED 가 아닌 이벤트는 제외한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertEvent(t, {
      effectiveDate: '2026-03-10',
      standardCode: 'KR7005930003',
      eventType: 'SHARES_CHANGED',
      oldValue: '"100"',
      newValue: '"90"',
      observedSpanStart: '2026-03-10',
    });

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([]);
    await t.close();
  });

  it('구간 밖 effectiveDate 는 제외한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertEvent(
      t,
      delistedEvent({
        effectiveDate: '2025-12-31',
        standardCode: 'KR7000660001',
        oldValue: JSON.stringify(entry({ standardCode: 'KR7000660001', shortCode: '000660' })),
      }),
    );

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([]);
    await t.close();
  });

  it('oldValue 가 없으면 건너뛴다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertEvent(
      t,
      delistedEvent({ effectiveDate: '2026-03-10', standardCode: 'KR7000660001', oldValue: null }),
    );

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([]);
    await t.close();
  });

  it('oldValue 파싱에 실패하면 건너뛴다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertEvent(
      t,
      delistedEvent({
        effectiveDate: '2026-03-10',
        standardCode: 'KR7000660001',
        oldValue: '{이것은-유효한-JSON이-아니다',
      }),
    );

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([]);
    await t.close();
  });

  it('oldValue 에 shortCode 가 없으면 건너뛴다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertEvent(
      t,
      delistedEvent({
        effectiveDate: '2026-03-10',
        standardCode: 'KR7000660001',
        oldValue: JSON.stringify({ standardCode: 'KR7000660001', name: 'SK하이닉스' }),
      }),
    );

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([]);
    await t.close();
  });

  it('effectiveDate 오름차순, 같은 날짜는 id(입력) 순서로 정렬한다', async () => {
    const t = await createTestApp();
    const svc = makeService(t);
    insertEvent(
      t,
      delistedEvent({
        effectiveDate: '2026-05-01',
        standardCode: 'KR7005930003',
        oldValue: JSON.stringify(entry({ standardCode: 'KR7005930003', shortCode: '005930' })),
      }),
    );
    insertEvent(
      t,
      delistedEvent({
        effectiveDate: '2026-03-10',
        standardCode: 'KR7000660001',
        oldValue: JSON.stringify(entry({ standardCode: 'KR7000660001', shortCode: '000660' })),
      }),
    );
    insertEvent(
      t,
      delistedEvent({
        effectiveDate: '2026-03-10',
        standardCode: 'KR7900001008',
        oldValue: JSON.stringify(entry({ standardCode: 'KR7900001008', shortCode: '900001' })),
      }),
    );

    expect(svc.delistedEventsBetween('2026-01-01', '2026-12-31')).toEqual([
      { shortCode: '000660', effectiveDate: '2026-03-10' },
      { shortCode: '900001', effectiveDate: '2026-03-10' },
      { shortCode: '005930', effectiveDate: '2026-05-01' },
    ]);
    await t.close();
  });
});
