import { describe, expect, it } from 'vitest';
import {
  DART_DAILY_CALL_LIMIT,
  planFactSync,
} from '../../src/server/modules/facts/domain/sync-plan.js';

const BASE = {
  symbols: ['005930', '000660'],
  fromYear: 2020,
  toYear: 2022,
  currentYear: 2022,
  coveredBySymbol: new Map<string, readonly number[]>(),
};

describe('planFactSync', () => {
  it('FULL 은 수집 이력을 무시하고 전 구간을 계획한다', () => {
    const plan = planFactSync({
      ...BASE,
      coveredBySymbol: new Map([['005930', [2020, 2021, 2022]]]),
      mode: 'FULL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([2020, 2021, 2022]);
    expect(plan.yearsBySymbol.get('000660')).toEqual([2020, 2021, 2022]);
  });

  it('INCREMENTAL 은 미수집 연도 + 현재 연도만 계획한다', () => {
    const plan = planFactSync({
      ...BASE,
      coveredBySymbol: new Map([['005930', [2020, 2022]]]),
      mode: 'INCREMENTAL',
    });
    // 2021 미수집 + 2022 는 현재 연도라 항상 다시 읽는다
    expect(plan.yearsBySymbol.get('005930')).toEqual([2021, 2022]);
    expect(plan.yearsBySymbol.get('000660')).toEqual([2020, 2021, 2022]);
  });

  it('불연속 수집 이력을 그대로 다룬다', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2018,
      toYear: 2024,
      currentYear: 2024,
      coveredBySymbol: new Map([['005930', [2018, 2019, 2023]]]),
      mode: 'INCREMENTAL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([2020, 2021, 2022, 2024]);
  });

  it('주식총수는 대상 연도 + 직전 1년을 읽는다 (자본변동 앵커)', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2022,
      currentYear: 2022,
      coveredBySymbol: new Map([['005930', [2020, 2021]]]),
      mode: 'INCREMENTAL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([2022]);
    expect(plan.shareYearsBySymbol.get('005930')).toEqual([2021, 2022]);
  });

  it('수집할 것이 없는 종목은 계획도 호출도 없다', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2021,
      currentYear: 2030,
      coveredBySymbol: new Map([['005930', [2020, 2021]]]),
      mode: 'INCREMENTAL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([]);
    expect(plan.shareYearsBySymbol.get('005930')).toEqual([]);
    expect(plan.calls).toBe(0);
    expect(plan.estimatedMs).toBe(0);
  });

  it('호출 수는 종목당 (연도 × 9 + 앵커 4) 이고 예상 시간은 × 120ms 다', () => {
    const plan = planFactSync({ ...BASE, mode: 'FULL' });
    // 종목 2개 × (3년 × 9 + 4) = 2 × 31 = 62
    expect(plan.calls).toBe(62);
    expect(plan.estimatedMs).toBe(62 * 120);
    expect(plan.overDailyLimit).toBe(false);
  });

  it('일일 한도(40,000) 초과를 표시한다', () => {
    const symbols = Array.from({ length: 200 }, (_, index) => String(index).padStart(6, '0'));
    const plan = planFactSync({
      symbols,
      fromYear: 2000,
      toYear: 2025,
      currentYear: 2025,
      coveredBySymbol: new Map(),
      mode: 'FULL',
    });
    // 200 × (26년 × 9 + 4) = 200 × 238 = 47,600
    expect(plan.calls).toBe(47_600);
    expect(plan.calls).toBeGreaterThan(DART_DAILY_CALL_LIMIT);
    expect(plan.overDailyLimit).toBe(true);
  });

  it('중복 심볼을 한 번만 계획한다', () => {
    const plan = planFactSync({
      symbols: ['005930', '005930'],
      fromYear: 2022,
      toYear: 2022,
      currentYear: 2022,
      coveredBySymbol: new Map(),
      mode: 'FULL',
    });
    expect(plan.yearsBySymbol.size).toBe(1);
    expect(plan.calls).toBe(13);
  });
});
