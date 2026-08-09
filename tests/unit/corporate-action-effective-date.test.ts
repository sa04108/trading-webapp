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

  it('같은 주식수 변경을 두 자본변동이 나눠 갖지 않는다', () => {
    const first = splitFact({ periodKey: '2024-09-27' });
    const second = splitFact({ periodKey: '2024-09-30' });

    const { facts, unaligned } = alignCorporateActionEffectiveDates([first, second], [sharesChange()]);

    const moved = facts.filter((fact) => fact.periodKey === '2024-10-08');
    expect(moved).toHaveLength(1);
    expect(unaligned).toHaveLength(1);
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
