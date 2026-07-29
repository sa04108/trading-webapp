import { describe, expect, it } from 'vitest';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { PitFactView, quarterOrdinal } from '../../src/server/modules/facts/domain/pit-fact-view.js';

const DAY = 86_400_000;

function fact(overrides: Partial<Fact> & Pick<Fact, 'field' | 'periodKey' | 'asOfTsMs' | 'value'>): Fact {
  return { scope: 'SYMBOL', key: '005930', unit: 'KRW', ...overrides };
}

describe('quarterOrdinal', () => {
  it('분기 키를 단조 정수로 바꾼다', () => {
    expect(quarterOrdinal('2025Q1')).toBe(2025 * 4);
    expect(quarterOrdinal('2025Q2')).toBe(2025 * 4 + 1);
    expect(quarterOrdinal('2026Q1')).toBe(2026 * 4);
  });

  it('분기 키가 아니면 null', () => {
    expect(quarterOrdinal('2025FY')).toBeNull();
    expect(quarterOrdinal('2025-03-14')).toBeNull();
  });
});

describe('PitFactView 룩어헤드 차단', () => {
  const disclosedQ1 = Date.UTC(2025, 4, 15); // 2025-05-15 에 Q1 공시
  const disclosedQ2 = Date.UTC(2025, 7, 14); // 2025-08-14 에 Q2 공시

  const facts: Fact[] = [
    fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: disclosedQ1, value: 100 }),
    fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: disclosedQ2, value: 200 }),
  ];

  it('공시 하루 전에는 그 분기 값이 보이지 않는다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ1 - DAY);
    expect(view.fundamentals('005930')).toBeNull();
  });

  it('공시 시각에는 그 분기 값이 보인다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ1);
    expect(view.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(100);
    expect(view.fundamentals('005930')?.latestPeriodKey).toBe('2025Q1');
  });

  it('Q2 공시 하루 전에는 여전히 Q1 을 반환한다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ2 - DAY);
    const snapshot = view.fundamentals('005930');
    expect(snapshot?.latestPeriodKey).toBe('2025Q1');
    expect(snapshot?.get('OPERATING_INCOME')).toBe(100);
  });

  it('Q2 공시 후에는 Q2 를 반환한다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ2);
    expect(view.fundamentals('005930')?.latestPeriodKey).toBe('2025Q2');
    expect(view.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(200);
  });

  it('커서는 되돌아가지 않는다 — 앞선 시점을 다시 요청해도 흡수한 팩트를 버리지 않는다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ2);
    view.advanceTo(disclosedQ1);
    expect(view.fundamentals('005930')?.latestPeriodKey).toBe('2025Q2');
  });
});

describe('PitFactView TTM', () => {
  it('직전 4개 분기 합을 낸다', () => {
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q3', asOfTsMs: 1_000, value: 10 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q4', asOfTsMs: 2_000, value: 20 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 3_000, value: 30 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: 4_000, value: 40 }),
    ]);
    view.advanceTo(4_000);
    expect(view.fundamentals('005930')?.ttm('OPERATING_INCOME')).toBe(100);
  });

  it('4개 분기가 채워지지 않으면 null', () => {
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 3_000, value: 30 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: 4_000, value: 40 }),
    ]);
    view.advanceTo(4_000);
    expect(view.fundamentals('005930')?.ttm('OPERATING_INCOME')).toBeNull();
  });

  it('중간 분기가 빠지면 null — 3개를 4개인 척 더하지 않는다', () => {
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q3', asOfTsMs: 1_000, value: 10 }),
      // 2024Q4 누락
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 3_000, value: 30 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: 4_000, value: 40 }),
    ]);
    view.advanceTo(4_000);
    expect(view.fundamentals('005930')?.ttm('OPERATING_INCOME')).toBeNull();
  });

  it('시점 계정(재무상태표)은 최신 분기 값을 그대로 준다', () => {
    const view = new PitFactView([
      fact({ field: 'CURRENT_ASSETS', periodKey: '2025Q1', asOfTsMs: 3_000, value: 500 }),
      fact({ field: 'CURRENT_ASSETS', periodKey: '2025Q2', asOfTsMs: 4_000, value: 600 }),
    ]);
    view.advanceTo(4_000);
    expect(view.fundamentals('005930')?.get('CURRENT_ASSETS')).toBe(600);
  });

  it('flow 가 아닌 계정은 4분기가 다 채워져도 TTM 이 null 이다', () => {
    const view = new PitFactView([
      fact({ field: 'CURRENT_ASSETS', periodKey: '2024Q3', asOfTsMs: 1_000, value: 10 }),
      fact({ field: 'CURRENT_ASSETS', periodKey: '2024Q4', asOfTsMs: 2_000, value: 20 }),
      fact({ field: 'CURRENT_ASSETS', periodKey: '2025Q1', asOfTsMs: 3_000, value: 30 }),
      fact({ field: 'CURRENT_ASSETS', periodKey: '2025Q2', asOfTsMs: 4_000, value: 40 }),
    ]);
    view.advanceTo(4_000);
    expect(view.fundamentals('005930')?.ttm('CURRENT_ASSETS')).toBeNull();
  });
});

describe('PitFactView 계정별 최신 분기 커서', () => {
  it('느린 주기의 계정은 다른 계정이 커서를 4분기 넘게 앞서 밀어도 값을 잃지 않는다', () => {
    // CURRENT_ASSETS 는 2024Q1 딱 한 번만 공시된다. OPERATING_INCOME 은 매 분기
    // 공시되어 전역 latestQuarter 를 2025Q2 까지(2024Q1 대비 5분기) 밀어올린다.
    // 예전 구현은 [latestQuarter-3, latestQuarter] 창으로만 계정을 조회했기
    // 때문에 이 시나리오에서 CURRENT_ASSETS 가 null 로 돌변했다.
    const view = new PitFactView([
      fact({ field: 'CURRENT_ASSETS', periodKey: '2024Q1', asOfTsMs: 1_000, value: 500 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q1', asOfTsMs: 1_000, value: 10 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q2', asOfTsMs: 2_000, value: 11 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q3', asOfTsMs: 3_000, value: 12 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q4', asOfTsMs: 4_000, value: 13 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 5_000, value: 14 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: 6_000, value: 15 }),
    ]);
    view.advanceTo(6_000);
    const snapshot = view.fundamentals('005930');
    expect(snapshot?.latestPeriodKey).toBe('2025Q2'); // 스냅샷 전체 신선도는 전역 최신 분기
    expect(snapshot?.get('CURRENT_ASSETS')).toBe(500); // 이 계정 자신의 최신 분기 값은 그대로
    expect(snapshot?.get('OPERATING_INCOME')).toBe(15);
  });
});

describe('PitFactView 재집계(restatement)', () => {
  it('같은 분기에 더 늦은 공시가 오면 그것이 이긴다', () => {
    const first = Date.UTC(2025, 4, 15);
    const restated = Date.UTC(2025, 10, 1);
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: first, value: 100 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: restated, value: 90 }),
    ]);
    view.advanceTo(restated - DAY);
    expect(view.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(100);

    const later = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: first, value: 100 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: restated, value: 90 }),
    ]);
    later.advanceTo(restated);
    expect(later.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(90);
  });

  it('latestAsOfTsMs 는 latestPeriodKey 를 만든 공시의 asOf 다 — 더 오래된 분기로의 뒤늦은 정정에 흔들리지 않는다', () => {
    const q1Disclosed = 1_000;
    const q2Disclosed = 2_000;
    const q1LateCorrection = 3_000; // Q1 에 대한 정정이지만 asOf 는 Q2 공시보다도 늦다
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: q1Disclosed, value: 100 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: q2Disclosed, value: 200 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: q1LateCorrection, value: 95 }),
    ]);
    view.advanceTo(q1LateCorrection);
    const snapshot = view.fundamentals('005930');
    // latestPeriodKey 는 여전히 2025Q2 — Q1 정정은 더 과거 분기라 전역 최신을 바꾸지 않는다
    expect(snapshot?.latestPeriodKey).toBe('2025Q2');
    // 그리고 latestAsOfTsMs 는 그 2025Q2 공시 시각(q2Disclosed)과 짝을 이뤄야 한다 —
    // Q1 정정의 asOf(q1LateCorrection)가 더 크다고 해서 끌려가면 안 된다
    expect(snapshot?.latestAsOfTsMs).toBe(q2Disclosed);
    // OPERATING_INCOME 자신의 최신 분기는 여전히 Q2이므로 값도 그대로다
    expect(snapshot?.get('OPERATING_INCOME')).toBe(200);
  });

  it('지금 최신인 분기에 대한 재집계는 latestAsOfTsMs 를 그 재집계 시각으로 밀어올린다', () => {
    const q1Disclosed = 1_000;
    const q1Restated = 5_000; // 같은 분기(2025Q1)에 대한 더 늦은 공시
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: q1Disclosed, value: 100 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: q1Restated, value: 110 }),
    ]);
    view.advanceTo(q1Restated);
    const snapshot = view.fundamentals('005930');
    // 분기 자체는 바뀌지 않는다 — 여전히 2025Q1
    expect(snapshot?.latestPeriodKey).toBe('2025Q1');
    // 하지만 그 분기를 다시 알려온 시각이 더 늦으므로 latestAsOfTsMs 는 갱신된다
    expect(snapshot?.latestAsOfTsMs).toBe(q1Restated);
    // 값도 재집계된 값을 반영한다
    expect(snapshot?.get('OPERATING_INCOME')).toBe(110);
  });
});

describe('PitFactView 자본변동 이벤트', () => {
  // 2025-03-10 공시, 2025-03-14 기준일 2:1 분할
  const announced = Date.UTC(2025, 2, 10);
  const splitFacts: Fact[] = [
    fact({
      field: 'SPLIT_RATIO',
      periodKey: '2025-03-14',
      asOfTsMs: announced,
      value: 2,
      unit: 'RATIO',
    }),
  ];

  it('공시 전에는 이벤트가 보이지 않는다', () => {
    const view = new PitFactView(splitFacts);
    view.advanceTo(announced - DAY);
    expect(view.corporateActions('005930', Date.UTC(2025, 2, 20))).toEqual([]);
  });

  it('공시했지만 기준일 전이면 아직 적용하지 않는다', () => {
    const view = new PitFactView(splitFacts);
    view.advanceTo(Date.UTC(2025, 2, 12));
    expect(view.corporateActions('005930', Date.UTC(2025, 2, 12))).toEqual([]);
  });

  it('기준일 이후 봉에는 이벤트가 보인다', () => {
    const view = new PitFactView(splitFacts);
    const barTs = Date.UTC(2025, 2, 14, 0, 0); // 기준일 KST 09:00 = UTC 00:00
    view.advanceTo(barTs);
    const actions = view.corporateActions('005930', barTs);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.ratio).toBe(2);
  });

  it('자본변동 이벤트는 재무 스냅샷에 섞이지 않는다', () => {
    const view = new PitFactView(splitFacts);
    view.advanceTo(Date.UTC(2025, 2, 20));
    expect(view.fundamentals('005930')).toBeNull();
  });
});

describe('PitFactView 흡수 순서 결정성', () => {
  it('같은 asOfTsMs 를 가진 팩트들의 입력 배열 순서가 달라도 결과가 동일하다', () => {
    // 세 팩트 모두 asOfTsMs 가 같다 — 정렬이 asOfTsMs 만 본다면 입력 순서(=배열 순서,
    // 예컨대 Parquet 행 순서)에 따라 재집계 승자·계정별 최신값이 달라질 수 있다.
    const asOf = 1_000;
    const factsInOrderA: Fact[] = [
      fact({ key: '005930', field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: asOf, value: 100 }),
      fact({ key: '005930', field: 'CURRENT_ASSETS', periodKey: '2025Q1', asOfTsMs: asOf, value: 500 }),
      fact({ key: '000660', field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: asOf, value: 55 }),
    ];
    const factsInOrderB: Fact[] = [factsInOrderA[2] as Fact, factsInOrderA[0] as Fact, factsInOrderA[1] as Fact];

    const viewA = new PitFactView(factsInOrderA);
    const viewB = new PitFactView(factsInOrderB);
    viewA.advanceTo(asOf);
    viewB.advanceTo(asOf);

    const snapshotA = viewA.fundamentals('005930');
    const snapshotB = viewB.fundamentals('005930');
    expect(snapshotB?.get('OPERATING_INCOME')).toBe(snapshotA?.get('OPERATING_INCOME'));
    expect(snapshotB?.get('CURRENT_ASSETS')).toBe(snapshotA?.get('CURRENT_ASSETS'));
    expect(snapshotB?.ttm('OPERATING_INCOME')).toBe(snapshotA?.ttm('OPERATING_INCOME'));
    expect(snapshotB?.latestAsOfTsMs).toBe(snapshotA?.latestAsOfTsMs);
    expect(viewB.fundamentals('000660')?.get('OPERATING_INCOME')).toBe(
      viewA.fundamentals('000660')?.get('OPERATING_INCOME'),
    );
  });
});

describe('PitFactView 종목 격리', () => {
  it('한 종목의 팩트가 다른 종목에 새지 않는다', () => {
    const view = new PitFactView([
      fact({ key: '005930', field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 1_000, value: 100 }),
      fact({ key: '000660', field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 1_000, value: 55 }),
    ]);
    view.advanceTo(1_000);
    expect(view.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(100);
    expect(view.fundamentals('000660')?.get('OPERATING_INCOME')).toBe(55);
    expect(view.fundamentals('999999')).toBeNull();
  });

  it('MACRO 스코프 팩트는 종목 스냅샷에 들어가지 않는다', () => {
    const view = new PitFactView([
      { scope: 'MACRO', key: 'KR_BASE_RATE', field: 'RATE', periodKey: '2025-03-01', asOfTsMs: 1_000, value: 3.5, unit: 'PERCENT' },
    ]);
    view.advanceTo(1_000);
    expect(view.fundamentals('KR_BASE_RATE')).toBeNull();
  });
});
