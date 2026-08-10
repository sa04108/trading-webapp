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

describe('PitFactView 분기 offset', () => {
  const announcedAt = 10_000;
  const eightQuarters: Fact[] = [
    ['2024Q1', 10],
    ['2024Q2', 20],
    ['2024Q3', 30],
    ['2024Q4', 40],
    ['2025Q1', 50],
    ['2025Q2', 60],
    ['2025Q3', 70],
    ['2025Q4', 80],
  ].map(([periodKey, value]) =>
    fact({ field: 'NET_INCOME', periodKey: String(periodKey), asOfTsMs: announcedAt, value: Number(value) }),
  );

  it('공시 시각 전에는 보이지 않고, 공시 뒤 calendar quarter offset으로 최대 8개 분기를 조회한다', () => {
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2023Q4', asOfTsMs: 1, value: 1 }),
      ...eightQuarters,
    ]);
    view.advanceTo(announcedAt - 1);
    expect(view.fundamentals('005930')?.quarter('NET_INCOME', 0)).toBeNull();

    view.advanceTo(announcedAt);
    const snapshot = view.fundamentals('005930')!;
    expect(snapshot.quarter('NET_INCOME', 0)).toEqual({ periodKey: '2025Q4', value: 80 });
    expect(snapshot.quarter('NET_INCOME', 1)).toEqual({ periodKey: '2025Q3', value: 70 });
    expect(snapshot.quarter('NET_INCOME', 7)?.periodKey).toBe('2024Q1');
    expect(snapshot.ttm('NET_INCOME', 0)).toBe(260);
    expect(snapshot.ttm('NET_INCOME', 4)).toBe(100);
  });

  it('중간 분기가 비면 offset이 이전 공시를 건너뛰지 않고 null을 준다', () => {
    const view = new PitFactView(eightQuarters.filter((entry) => entry.periodKey !== '2024Q4'));
    view.advanceTo(announcedAt);

    const snapshot = view.fundamentals('005930')!;
    expect(snapshot.quarter('NET_INCOME', 4)).toBeNull();
    expect(snapshot.ttm('NET_INCOME', 4)).toBeNull();
  });

  it('시점 계정은 TTM 합산 대상이 아니다', () => {
    const view = new PitFactView(
      eightQuarters.map((entry) => ({ ...entry, field: 'TOTAL_EQUITY' })),
    );
    view.advanceTo(announcedAt);

    expect(view.fundamentals('005930')?.ttm('TOTAL_EQUITY', 0)).toBeNull();
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

describe('PitFactView periodKeyOf (계정별 신선도)', () => {
  it('get() 이 반환할 값이 속한 분기 키를 준다 — 계정마다 공시 주기가 달라도 각자 자신의 최신 분기를 본다', () => {
    // CURRENT_ASSETS 는 2024Q1 딱 한 번만 공시된다. OPERATING_INCOME 은 매 분기
    // 공시되어 전역 latestQuarter 를 2025Q2 까지 밀어올린다 — '계정별 최신 분기
    // 커서' 테스트와 같은 픽스처를 재사용해, periodKeyOf 가 get() 과 같은 소스를
    // 보고 있음을 확인한다.
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
    // 스냅샷 전체 신선도(전사 최댓값)는 2025Q2 이지만
    expect(snapshot?.latestPeriodKey).toBe('2025Q2');
    // CURRENT_ASSETS 자신의 분기는 여전히 2024Q1 — 전역 커서에 끌려가지 않는다
    expect(snapshot?.periodKeyOf('CURRENT_ASSETS')).toBe('2024Q1');
    expect(snapshot?.periodKeyOf('OPERATING_INCOME')).toBe('2025Q2');
  });

  it('공시가 없는 계정은 null 을 준다', () => {
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 1_000, value: 10 }),
    ]);
    view.advanceTo(1_000);
    const snapshot = view.fundamentals('005930');
    expect(snapshot?.get('TANGIBLE_ASSETS')).toBeNull();
    expect(snapshot?.periodKeyOf('TANGIBLE_ASSETS')).toBeNull();
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
  /** periodKey '2025-03-14' 의 효력발생 시각 = 2025-03-14 00:00 KST */
  const effective = Date.UTC(2025, 2, 13, 15, 0);
  const splitFacts: Fact[] = [
    fact({
      field: 'SPLIT_RATIO',
      periodKey: '2025-03-14',
      asOfTsMs: announced,
      value: 2,
      unit: 'RATIO',
    }),
  ];

  /**
   * 이 테스트는 원래 "공시 전에는 이벤트가 보이지 않는다" 였다 — 즉 asOf 게이트를
   * 못박고 있었다. 설계 §3.4 는 그 반대를 규정한다: `corporateActions` 는 **효력발생일
   * ≤ 현재 봉** 인 이벤트를 노출하고, "이미 발생한 분할로 과거 가격을 보정하는 것은
   * 룩어헤드가 아니다".
   *
   * asOf 게이트는 실제로 결과를 망친다: 자본변동 수량은 사업보고서의 증자·감자 현황에서
   * 읽으므로 접수일이 기준일보다 최대 15개월 늦다. 2025-03-14 기준 2:1 분할은 2026년 3월
   * 사업보고서에서야 뷰에 들어오고, 그 1년 동안 월간 리밸런스는 미보정 가격에서 12개월
   * 수익률 −50% 를 읽어 기본 절대 모멘텀 필터가 그 종목을 조용히 떨어뜨린다. 경제적으로도
   * 틀렸다 — 기준일 이후 어느 봉에서든 실제 참여자는 주가가 분할된 사실을 알고 있고,
   * 사업보고서는 우리 쪽 데이터 출처일 뿐 시장이 알게 된 경로가 아니다.
   */
  it('커서를 한 번도 전진시키지 않아도 기준일 게이트만으로 노출된다', () => {
    const view = new PitFactView(splitFacts);
    expect(view.corporateActions('005930', Date.UTC(2025, 2, 20))).toHaveLength(1);
    expect(view.corporateActions('005930', Date.UTC(2025, 2, 1))).toEqual([]);
  });

  it('경계: 봉이 정확히 효력발생 시각이면 포함되고 1ms 앞이면 제외된다', () => {
    // 기존 케이스들은 기준일 KST 09:00(효력발생 시각보다 9시간 뒤)을 봉으로 써서
    // 게이트를 `<=` 에서 `<` 로 바꿔도 살아남았다 — 경계를 정확히 짚는다.
    const view = new PitFactView(splitFacts);
    view.advanceTo(effective);
    expect(view.corporateActions('005930', effective)).toHaveLength(1);
    expect(view.corporateActions('005930', effective - 1)).toEqual([]);
  });

  it('자본변동 이벤트는 재무 스냅샷에 섞이지 않는다', () => {
    const view = new PitFactView(splitFacts);
    view.advanceTo(Date.UTC(2025, 2, 20));
    expect(view.fundamentals('005930')).toBeNull();
  });

  it('여러 분할은 효력발생일 오름차순으로 노출된다 (입력 순서와 무관)', () => {
    const view = new PitFactView([
      fact({ field: 'SPLIT_RATIO', periodKey: '2025-09-01', asOfTsMs: 9_000, value: 3, unit: 'RATIO' }),
      fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: 8_000, value: 2, unit: 'RATIO' }),
    ]);
    const actions = view.corporateActions('005930', Date.UTC(2025, 11, 1));
    expect(actions.map((action) => action.ratio)).toEqual([2, 3]);
  });
});

/**
 * R2: 같은 분할이 두 행으로 남는 경로가 실재한다 — 저장소의 병합 키는 정정공시를 새 행으로
 * 보존하려고 asOfTsMs 를 포함하고, DART 어댑터는 한 번의 `fetchCorporateActions` 호출
 * 안에서만 중복을 접는다. 부분 실패 복구 안내가 `--from`/`--to` 를 좁혀 재실행하라고 하므로
 * 구간을 나눈 수집은 표준 경로다. 접지 않으면 2:1 분할이 배수 4 가 된다.
 */
describe('PitFactView 자본변동 중복 접기', () => {
  /** 분할 전 봉을 보정할 때 곱해지는 배수 — corporateActions 를 그대로 재현한다 */
  function adjustmentFactor(view: PitFactView, barTsMs: number, atTsMs: number): number {
    return view
      .corporateActions('005930', atTsMs)
      .filter((action) => action.effectiveTsMs > barTsMs)
      .reduce((factor, action) => factor * action.ratio, 1);
  }

  const beforeSplit = Date.UTC(2025, 2, 1);
  const after = Date.UTC(2025, 11, 1);

  it('같은 분할이 접수번호가 다른 두 행으로 들어와도 이벤트 하나·배수 하나다', () => {
    const view = new PitFactView([
      // 첫 sync 구간: FY2025 사업보고서(2026-03 접수)에서 읽은 2:1 분할
      fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: Date.UTC(2026, 2, 20), value: 2, unit: 'RATIO' }),
      // 두 번째 sync 구간: 접수번호가 다른 보고서에서 같은 분할을 다시 읽었다
      fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: Date.UTC(2026, 5, 10), value: 2, unit: 'RATIO' }),
    ]);
    const actions = view.corporateActions('005930', after);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.ratio).toBe(2);
    // 접지 않으면 여기가 4 가 된다 — 신호가 조용히 두 배로 왜곡되는 지점
    expect(adjustmentFactor(view, beforeSplit, after)).toBe(2);
  });

  it('세 번 중복돼도 배수는 그대로다', () => {
    const view = new PitFactView(
      [Date.UTC(2026, 2, 20), Date.UTC(2026, 5, 10), Date.UTC(2026, 8, 1)].map((asOfTsMs) =>
        fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs, value: 2, unit: 'RATIO' }),
      ),
    );
    expect(view.corporateActions('005930', after)).toHaveLength(1);
    expect(adjustmentFactor(view, beforeSplit, after)).toBe(2);
  });

  it('효력발생일이 다른 두 분할은 접히지 않는다 — 배수는 곱해진다', () => {
    const view = new PitFactView([
      fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: 8_000, value: 2, unit: 'RATIO' }),
      fact({ field: 'SPLIT_RATIO', periodKey: '2025-09-01', asOfTsMs: 9_000, value: 3, unit: 'RATIO' }),
    ]);
    expect(view.corporateActions('005930', after)).toHaveLength(2);
    expect(adjustmentFactor(view, beforeSplit, after)).toBe(6);
  });

  it('비율이 다른 충돌은 가장 이른 공시를 택한다 — 입력 순서와 무관하게 같은 결과', () => {
    const early = fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: Date.UTC(2026, 2, 20), value: 2, unit: 'RATIO' });
    const late = fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: Date.UTC(2026, 5, 10), value: 5, unit: 'RATIO' });

    for (const facts of [[early, late], [late, early]]) {
      const view = new PitFactView(facts);
      const actions = view.corporateActions('005930', after);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.ratio).toBe(2);
    }
  });

  it('접수일까지 같은 충돌도 결정적이다 — 비율이 작은 쪽', () => {
    const asOfTsMs = Date.UTC(2026, 2, 20);
    const small = fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs, value: 2, unit: 'RATIO' });
    const large = fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs, value: 5, unit: 'RATIO' });

    for (const facts of [[small, large], [large, small]]) {
      const actions = new PitFactView(facts).corporateActions('005930', after);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.ratio).toBe(2);
    }
  });

  it('같은 비율 중복이 먼저 와도 뒤이은 충돌의 승자가 바뀌지 않는다', () => {
    // 중복을 접을 때 접수일을 가장 이른 값으로 유지하지 않으면 이 결과가 순서로 갈린다
    const duplicateLate = fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: 300, value: 2, unit: 'RATIO' });
    const duplicateEarly = fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: 100, value: 2, unit: 'RATIO' });
    const conflict = fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: 200, value: 7, unit: 'RATIO' });

    for (const facts of [
      [duplicateLate, duplicateEarly, conflict],
      [conflict, duplicateLate, duplicateEarly],
      [duplicateEarly, conflict, duplicateLate],
    ]) {
      const actions = new PitFactView(facts).corporateActions('005930', after);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.ratio).toBe(2);
    }
  });

  it('효력발생일이 같은 두 종목은 서로 접히지 않는다', () => {
    const view = new PitFactView([
      fact({ key: '005930', field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: 8_000, value: 2, unit: 'RATIO' }),
      fact({ key: '000660', field: 'SPLIT_RATIO', periodKey: '2025-03-14', asOfTsMs: 8_000, value: 5, unit: 'RATIO' }),
    ]);
    expect(view.corporateActions('005930', after).map((a) => a.ratio)).toEqual([2]);
    expect(view.corporateActions('000660', after).map((a) => a.ratio)).toEqual([5]);
  });
});

describe('PitFactView 흡수 순서 결정성', () => {
  it('key·field·periodKey·asOfTsMs 가 전부 같은 진짜 중복끼리는 배열 순서와 무관하게 같은 값으로 수렴한다', () => {
    // 흡수 순서가 결과에 영향을 주는 유일한 경우는 두 팩트가 같은 맵 슬롯
    // (key, field, periodKey) 을 다투는 경우다. asOfTsMs 까지 같다면 그 슬롯을
    // 다투는 두 팩트는 정말로 완전한 중복(값만 다름) 이라, asOfTsMs 만 보는
    // 정렬은 물론이고 key/field/periodKey 만 보조 키로 쓰는 정렬도 이 경우엔
    // 동점(0)으로 떨어져 안정 정렬이 입력 배열 순서를 그대로 보존해버린다 —
    // 즉 배열 순서가 승자를 결정하게 된다. value 를 최종 타이브레이커로 넣어야
    // 이 경우까지 결정적이다.
    const asOf = 1_000;
    const low = fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: asOf, value: 100 });
    const high = fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: asOf, value: 200 });

    const viewLowFirst = new PitFactView([low, high]);
    const viewHighFirst = new PitFactView([high, low]);
    viewLowFirst.advanceTo(asOf);
    viewHighFirst.advanceTo(asOf);

    expect(viewHighFirst.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(
      viewLowFirst.fundamentals('005930')?.get('OPERATING_INCOME'),
    );
  });

  it('key/field 가 다른 동시각 팩트들도 입력 배열 순서와 무관하게 결과가 동일하다', () => {
    // 이쪽은 애초에 같은 맵 슬롯을 다투지 않으므로 asOfTsMs 만으로도 이미
    // 결정적이지만, 회귀 방지 차원에서 key·field 보조 키 경로도 함께 확인한다.
    const asOf = 2_000;
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
