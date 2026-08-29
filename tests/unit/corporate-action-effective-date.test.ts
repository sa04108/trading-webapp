import { describe, expect, it } from 'vitest';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../src/server/modules/facts/domain/fact.js';
import {
  alignCorporateActionEffectiveDates,
  type SharesChange,
} from '../../src/server/modules/facts/domain/corporate-action-effective-date.js';

function splitFact(overrides: Partial<Fact> = {}): Fact {
  return {
    scope: 'SYMBOL',
    key: '007340',
    field: CORPORATE_ACTION_FIELD,
    periodKey: '2024-09-27',
    asOfTsMs: Date.parse('2025-03-20T09:00:00Z'),
    value: 5,
    unit: 'RATIO',
    ...overrides,
  };
}

function sharesChange(overrides: Partial<SharesChange> = {}): SharesChange {
  return {
    shortCode: '007340',
    effectiveDate: '2024-10-08',
    ratio: 5,
    ...overrides,
  };
}

describe('alignCorporateActionEffectiveDates', () => {
  it('DART 기준일을 KRX 상장주식수가 실제로 바뀐 날로 옮긴다', () => {
    const { facts } = alignCorporateActionEffectiveDates([splitFact()], [sharesChange()]);

    expect(facts[0]?.periodKey).toBe('2024-10-08');
  });

  it('DART 기준일과 KRX 변경일이 같으면 자기 날짜 충돌로 오인하지 않는다', () => {
    const fact = splitFact({ periodKey: '2024-10-08' });
    const { facts, unaligned } = alignCorporateActionEffectiveDates([fact], [sharesChange()]);

    expect(facts).toEqual([fact]);
    expect(unaligned).toEqual([]);
  });

  it('자본변동이 아닌 팩트는 건드리지 않는다', () => {
    const financial = splitFact({ field: 'OPERATING_INCOME', periodKey: '2024Q3' });

    const { facts } = alignCorporateActionEffectiveDates([financial], [sharesChange()]);

    expect(facts[0]).toEqual(financial);
  });

  it('비율이 다른 주식수 변경은 짝으로 보지 않는다 — 유상증자에 분할을 갖다 붙이지 않는다', () => {
    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [splitFact()],
      [sharesChange({ ratio: 1.02 })],
    );

    expect(facts[0]?.periodKey).toBe('2024-09-27');
    expect(unaligned).toEqual([{ symbol: '007340', periodKey: '2024-09-27', ratio: 5 }]);
  });

  it('KRX 한 변경에 유상증자와 정수배 분할이 섞여도 DART 사건 직후 주식수로 정렬한다', () => {
    const fact = splitFact({
      periodKey: '2016-08-17',
      value: 5,
      corporateActionBeforeShares: 11_479_354,
      corporateActionAfterShares: 57_396_770,
    });
    const compositeChange = sharesChange({
      effectiveDate: '2016-09-07',
      ratio: 57_396_770 / 10_607_380,
      beforeShares: 10_607_380,
      afterShares: 57_396_770,
    });

    const { facts, unaligned } = alignCorporateActionEffectiveDates([fact], [compositeChange]);

    expect(facts[0]?.periodKey).toBe('2016-09-07');
    expect(unaligned).toEqual([]);
  });

  it('절대 주식수 근거가 없으면 오차가 큰 복합 변경을 추측하지 않는다', () => {
    const fact = splitFact({ periodKey: '2016-08-17', value: 5 });
    const compositeChange = sharesChange({
      effectiveDate: '2016-09-07',
      ratio: 57_396_770 / 10_607_380,
    });

    const { facts, unaligned } = alignCorporateActionEffectiveDates([fact], [compositeChange]);

    expect(facts).toEqual([fact]);
    expect(unaligned).toHaveLength(1);
  });

  it('KRX 비율과 전후 주식수가 서로 모순이면 복합 변경으로 인정하지 않는다', () => {
    const fact = splitFact({
      periodKey: '2016-08-17',
      value: 5,
      corporateActionBeforeShares: 11_479_354,
      corporateActionAfterShares: 57_396_770,
    });
    const inconsistentChange = sharesChange({
      effectiveDate: '2016-09-07',
      ratio: 5.3,
      beforeShares: 10_607_380,
      afterShares: 57_396_770,
    });

    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [fact],
      [inconsistentChange],
    );

    expect(facts).toEqual([fact]);
    expect(unaligned).toHaveLength(1);
  });

  it('작은 증감은 총 비율이 아니라 변화분의 크기로 짝을 판정한다', () => {
    const fact = splitFact({ value: 1.02 });
    const differentIncrease = alignCorporateActionEffectiveDates(
      [fact],
      [sharesChange({ ratio: 1.07 })],
    );
    const oppositeDirection = alignCorporateActionEffectiveDates(
      [fact],
      [sharesChange({ ratio: 0.98 })],
    );
    const matchingIncrease = alignCorporateActionEffectiveDates(
      [fact],
      [sharesChange({ ratio: 1.021 })],
    );

    expect(differentIncrease.unaligned).toHaveLength(1);
    expect(oppositeDirection.unaligned).toHaveLength(1);
    expect(matchingIncrease.unaligned).toEqual([]);
  });

  it('심한 병합은 변화분뿐 아니라 총 비율도 가까워야 같은 사건으로 본다', () => {
    const fact = splitFact({ value: 0.05 });
    const differentConsolidation = alignCorporateActionEffectiveDates(
      [fact],
      [sharesChange({ ratio: 0.01 })],
    );
    const matchingConsolidation = alignCorporateActionEffectiveDates(
      [fact],
      [sharesChange({ ratio: 0.051 })],
    );

    expect(differentConsolidation.unaligned).toHaveLength(1);
    expect(matchingConsolidation.unaligned).toEqual([]);
  });

  it('짝이 될 주식수 변경이 없으면 DART 기준일을 그대로 둔다', () => {
    const { facts, unaligned } = alignCorporateActionEffectiveDates([splitFact()], []);

    expect(facts[0]?.periodKey).toBe('2024-09-27');
    expect(unaligned).toHaveLength(1);
  });

  it('다른 종목의 주식수 변경에는 붙지 않는다', () => {
    const { facts } = alignCorporateActionEffectiveDates(
      [splitFact()],
      [sharesChange({ shortCode: '000660' })],
    );

    expect(facts[0]?.periodKey).toBe('2024-09-27');
  });

  it('탐색 창을 벗어난 주식수 변경은 짝으로 보지 않는다', () => {
    const { facts } = alignCorporateActionEffectiveDates(
      [splitFact()],
      [sharesChange({ effectiveDate: '2025-03-01' })],
    );

    expect(facts[0]?.periodKey).toBe('2024-09-27');
  });

  it('기준일보다 앞선 주식수 변경도 창 안이면 짝이 된다 — KRX 관측이 먼저인 경우가 있다', () => {
    const { facts } = alignCorporateActionEffectiveDates(
      [splitFact()],
      [sharesChange({ effectiveDate: '2024-09-25' })],
    );

    expect(facts[0]?.periodKey).toBe('2024-09-25');
  });

  it('후보가 여럿이면 기준일에 가장 가까운 하나를 쓴다', () => {
    const { facts } = alignCorporateActionEffectiveDates(
      [splitFact()],
      [sharesChange({ effectiveDate: '2024-11-20' }), sharesChange({ effectiveDate: '2024-10-08' })],
    );

    expect(facts[0]?.periodKey).toBe('2024-10-08');
  });

  it('정렬 건수와 총 날짜 거리가 같으면 비율 오차가 가장 작은 조합을 쓴다', () => {
    const first = splitFact({ periodKey: '2024-06-01', value: 2.04 });
    const second = splitFact({ periodKey: '2024-06-03', value: 2 });

    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [first, second],
      [
        sharesChange({ effectiveDate: '2024-06-10', ratio: 2 }),
        sharesChange({ effectiveDate: '2024-06-12', ratio: 2.04 }),
      ],
    );

    expect(facts.map((fact) => fact.periodKey)).toEqual(['2024-06-12', '2024-06-10']);
    expect(unaligned).toEqual([]);
  });

  it('같은 주식수 변경을 두 자본변동이 나눠 갖지 않는다', () => {
    const first = splitFact({ periodKey: '2024-09-27' });
    const second = splitFact({ periodKey: '2024-09-30' });

    const { facts, unaligned } = alignCorporateActionEffectiveDates([first, second], [sharesChange()]);

    const moved = facts.filter((fact) => fact.periodKey === '2024-10-08');
    expect(moved).toHaveLength(1);
    expect(unaligned).toHaveLength(1);
  });

  it('탐욕 선택보다 정렬 건수가 많은 짝 조합을 우선한다', () => {
    const earlier = splitFact({ periodKey: '2024-10-01', value: 2 });
    const later = splitFact({ periodKey: '2024-10-21', value: 2 });

    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [later, earlier],
      [
        sharesChange({ effectiveDate: '2024-10-11', ratio: 2 }),
        sharesChange({ effectiveDate: '2024-09-01', ratio: 2 }),
      ],
    );

    expect(facts.map((fact) => fact.periodKey).sort()).toEqual(['2024-09-01', '2024-10-11']);
    expect(unaligned).toEqual([]);
  });

  it('다른 사건의 원래 날짜는 그 사건이 함께 이동할 때만 연쇄적으로 쓴다', () => {
    const first = splitFact({ periodKey: '2024-10-01', value: 2 });
    const second = splitFact({ periodKey: '2024-10-11', value: 3 });

    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [first, second],
      [
        sharesChange({ effectiveDate: '2024-10-11', ratio: 2 }),
        sharesChange({ effectiveDate: '2024-10-21', ratio: 3 }),
      ],
    );

    expect(facts.map((fact) => fact.periodKey)).toEqual(['2024-10-11', '2024-10-21']);
    expect(unaligned).toEqual([]);
  });

  it('변경 행이 여러 개여도 같은 최종 효력일에는 한 사건만 배정한다', () => {
    const first = splitFact({ periodKey: '2024-10-01', value: 2 });
    const second = splitFact({ periodKey: '2024-10-02', value: 2 });

    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [first, second],
      [
        sharesChange({ effectiveDate: '2024-10-11', ratio: 2 }),
        sharesChange({ effectiveDate: '2024-10-11', ratio: 2 }),
      ],
    );

    expect(facts.filter((fact) => fact.periodKey === '2024-10-11')).toHaveLength(1);
    expect(unaligned).toHaveLength(1);
  });

  it('같은 KRX 변경일에 비율이 상충하면 맞아 보이는 한 행을 임의 채택하지 않는다', () => {
    const fact = splitFact({ periodKey: '2024-10-01', value: 2 });

    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [fact],
      [
        sharesChange({ effectiveDate: '2024-10-11', ratio: 2 }),
        sharesChange({ effectiveDate: '2024-10-11', ratio: 5 }),
      ],
    );

    expect(facts).toEqual([fact]);
    expect(unaligned).toEqual([{ symbol: '007340', periodKey: '2024-10-01', ratio: 2 }]);
  });

  it('같은 분할의 재공시는 접은 뒤 변경상장일로 옮긴다', () => {
    const first = splitFact();
    const repeated = splitFact({ asOfTsMs: Date.parse('2026-03-20T09:00:00Z') });

    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [repeated, first],
      [sharesChange()],
    );

    expect(facts).toEqual([{ ...first, periodKey: '2024-10-08' }]);
    expect(unaligned).toEqual([]);
  });

  it('같은 기준일의 상충 비율 공시는 하나를 임의 채택하지 않고 미정렬로 막는다', () => {
    const first = splitFact({ value: 5 });
    const correction = splitFact({
      asOfTsMs: Date.parse('2026-03-20T09:00:00Z'),
      value: 2,
    });

    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [correction, first],
      [sharesChange({ ratio: 5 })],
    );

    expect(facts).toEqual([first]);
    expect(unaligned).toEqual([{ symbol: '007340', periodKey: '2024-09-27', ratio: 5 }]);
  });

  it('같은 비율이어도 직전·직후 주식수가 상충하면 하나를 임의 채택하지 않는다', () => {
    const first = splitFact({
      value: 5,
      corporateActionBeforeShares: 10,
      corporateActionAfterShares: 50,
    });
    const correction = splitFact({
      asOfTsMs: Date.parse('2026-03-20T09:00:00Z'),
      value: 5,
      corporateActionBeforeShares: 11,
      corporateActionAfterShares: 55,
    });

    const { facts, unaligned } = alignCorporateActionEffectiveDates(
      [correction, first],
      [sharesChange({ ratio: 5, beforeShares: 10, afterShares: 50 })],
    );

    expect(facts).toEqual([first]);
    expect(unaligned).toEqual([{ symbol: '007340', periodKey: '2024-09-27', ratio: 5 }]);
  });

  it('옮긴 결과가 다른 자본변동의 기준일과 겹치면 옮기지 않는다 — 뷰가 둘을 한 칸으로 접는다', () => {
    const moved = splitFact({ periodKey: '2024-09-27' });
    const parked = splitFact({ periodKey: '2024-10-08', value: 2 });

    const { facts } = alignCorporateActionEffectiveDates(
      [moved, parked],
      [sharesChange({ effectiveDate: '2024-10-08' })],
    );

    expect(facts.map((fact) => fact.periodKey).sort()).toEqual(['2024-09-27', '2024-10-08']);
  });

  it('입력 배열을 바꾸지 않는다', () => {
    const facts = [splitFact()];

    alignCorporateActionEffectiveDates(facts, [sharesChange()]);

    expect(facts[0]?.periodKey).toBe('2024-09-27');
  });
});
