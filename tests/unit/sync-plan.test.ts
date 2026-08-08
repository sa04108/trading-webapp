import { describe, expect, it } from 'vitest';
import {
  DART_DAILY_CALL_LIMIT,
  estimateCorporateActionSyncCost,
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

  /**
   * 불연속 `years` 에 앵커를 가장 이른 연도 앞에만 두면 구멍 건너편의 낡은 공시가
   * 분모가 된다. 예: 2021–2025 를 이미 받은 데이터셋이 2019–2026 을 증분 요청하면
   * 대상은 [2019, 2020, 2026] 인데 주식총수가 2020 까지만 읽혀, 2026-02 분할의
   * `sharesBefore()` 가 5년 묵은 2020 사업보고서 값을 집는다. 분모가 null 이 아니므로
   * `parseIssuanceRows` 는 gap 도 남기지 않는다 — 조용히 틀린 비율이 보정가격 전체를
   * 오염시킨다. 그래서 구간마다 앵커가 필요하다.
   */
  const SPARSE = {
    symbols: ['005930'],
    fromYear: 2019,
    toYear: 2026,
    currentYear: 2026,
    coveredBySymbol: new Map([['005930', [2021, 2022, 2023, 2024, 2025]]]),
    mode: 'INCREMENTAL',
  } as const;

  it('불연속 연도는 연속 구간마다 직전 1년을 앵커로 읽는다', () => {
    const plan = planFactSync(SPARSE);
    expect(plan.yearsBySymbol.get('005930')).toEqual([2019, 2020, 2026]);
    // 2018 은 [2019,2020] 구간의 앵커, 2025 는 [2026] 구간의 앵커다
    expect(plan.shareYearsBySymbol.get('005930')).toEqual([2018, 2019, 2020, 2025, 2026]);
  });

  it('불연속이면 앵커 호출도 구간 수만큼 늘어난다', () => {
    const plan = planFactSync(SPARSE);
    // 3년 × 9 + 앵커 2구간 × 4 = 27 + 8 = 35. 이 수가 어댑터가 실제로 쏘는 호출 수와
    // 같아야 화면 추정치가 거짓말하지 않는다.
    expect(plan.calls).toBe(35);
    expect(plan.estimatedMs).toBe(35 * 120);
    // 앵커 수는 곧 shareYears 가 years 보다 몇 개 많은지다
    const years = plan.yearsBySymbol.get('005930') ?? [];
    const shareYears = plan.shareYearsBySymbol.get('005930') ?? [];
    expect(shareYears.length - years.length).toBe(2);
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

/**
 * 자본변동 전용 비용(Task 8) — `planFactSync` 의 `calls` 는 재무(`fnlttSinglAcntAll`)
 * 까지 포함하므로 `syncCorporateActions` 가 실제로 쏘는 호출보다 많다. 위저드 게이트
 * 화면은 이 함수의 값을 써야 실행과 추정이 갈리지 않는다(브리프의 함정 1번).
 */
describe('estimateCorporateActionSyncCost', () => {
  it('종목당 (연도 × 1 + shareYears × 4) 다 — 재무 호출을 세지 않는다', () => {
    const plan = planFactSync({ ...BASE, mode: 'FULL' });
    // 종목 2개, 각 3년(2020~2022) + 앵커 1(2019) = shareYears 4개
    // 종목당 3×1 + 4×4 = 19, 2종목이면 38
    expect(plan.calls).toBe(62); // planFactSync 의 값(재무 포함)과는 다르다는 대조군
    const estimate = estimateCorporateActionSyncCost(plan);
    expect(estimate.calls).toBe(38);
    expect(estimate.estimatedMs).toBe(38 * 120);
    expect(estimate.overDailyLimit).toBe(false);
  });

  it('불연속 구간에서도 앵커가 shareYears 에 그대로 반영된다', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2019,
      toYear: 2026,
      currentYear: 2026,
      coveredBySymbol: new Map([['005930', [2021, 2022, 2023, 2024, 2025]]]),
      mode: 'INCREMENTAL',
    });
    // years=[2019,2020,2026](3) shareYears=[2018,2019,2020,2025,2026](5)
    // 3×1 + 5×4 = 23
    const estimate = estimateCorporateActionSyncCost(plan);
    expect(estimate.calls).toBe(23);
    expect(estimate.estimatedMs).toBe(23 * 120);
  });

  it('수집할 것이 없으면 비용도 없다', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2021,
      currentYear: 2030,
      coveredBySymbol: new Map([['005930', [2020, 2021]]]),
      mode: 'INCREMENTAL',
    });
    const estimate = estimateCorporateActionSyncCost(plan);
    expect(estimate.calls).toBe(0);
    expect(estimate.estimatedMs).toBe(0);
    expect(estimate.overDailyLimit).toBe(false);
  });
});
