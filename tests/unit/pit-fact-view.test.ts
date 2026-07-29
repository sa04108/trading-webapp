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
