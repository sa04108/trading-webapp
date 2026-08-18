import { describe, expect, it } from 'vitest';
import {
  DART_DAILY_CALL_LIMIT,
  estimateDartCalls,
  estimateCorporateActionSyncCost,
  filableReportCount,
  planFactSync,
} from '../../src/server/modules/facts/domain/sync-plan.js';

// 모든 대상 연도(~2022)가 끝난 뒤다 — 보고서 4종이 전부 존재할 수 있어
// 최대 호출 수 공식(연도당 12회)이 그대로 성립하는 대조군 날짜.
const AFTER_ALL_YEARS = '2023-06-01';

const BASE = {
  symbols: ['005930', '000660'],
  fromYear: 2020,
  toYear: 2022,
  todayKstDate: AFTER_ALL_YEARS,
  coveredBySymbol: new Map<string, readonly number[]>(),
};

describe('filableReportCount', () => {
  it('분기말이 지난 보고서만 센다', () => {
    // 2026-08-11: 1Q(03-31)·반기(06-30)는 지났고 3Q(09-30)·사업(12-31)은 아직이다
    expect(filableReportCount(2026, '2026-08-11')).toBe(2);
    expect(filableReportCount(2025, '2026-08-11')).toBe(4);
    expect(filableReportCount(2026, '2026-01-15')).toBe(0);
    // 분기말 당일에는 아직 기간이 끝나지 않았다
    expect(filableReportCount(2026, '2026-03-31')).toBe(0);
    expect(filableReportCount(2026, '2026-04-01')).toBe(1);
  });
});

describe('planFactSync', () => {
  it('연도 work unit 비용은 이미 읽은 주식총수 연도를 다시 세지 않는다', () => {
    expect(estimateDartCalls({
      symbol: '005930',
      year: 2025,
      shareYears: [2024, 2025],
      estimatedDartCalls: 0,
    }, '2026-06-01')).toBe(16);
    expect(estimateDartCalls({
      symbol: '005930',
      year: 2026,
      shareYears: [2025, 2026],
      estimatedDartCalls: 0,
    }, '2027-06-01', new Set([2024, 2025]))).toBe(12);
  });

  /**
   * 아직 기간이 끝나지 않은 보고서 조회는 항상 013(조회 없음)이다 (2026-08-11 운영
   * DART 검증: bsns_year=2026 의 3Q·사업보고서·irdsSttus 모두 013). 호출만 쓰고
   * 아무것도 받지 못하므로 계획에서 뺀다 — 이 수가 어댑터의 실제 호출과 같아야
   * 화면 추정치가 거짓말하지 않는다.
   */
  it('연도 work unit 비용은 미래 보고서를 세지 않는다', () => {
    // 2026-08-11 기준 2026년: fnltt 2 + irds 2 + 주식총수 2025년 4 + 2026년 2 = 10
    expect(estimateDartCalls({
      symbol: '005930',
      year: 2026,
      shareYears: [2025, 2026],
      estimatedDartCalls: 0,
    }, '2026-08-11')).toBe(10);
    // 자본변동 전용: irds 2 + 주식총수 2 (2025 앵커는 이미 읽음)
    expect(estimateDartCalls({
      symbol: '005930',
      year: 2026,
      shareYears: [2025, 2026],
      estimatedDartCalls: 0,
    }, '2026-08-11', new Set([2025]), false)).toBe(4);
  });

  it('INCREMENTAL 은 covered 연도를 forced 로 지정해야만 다시 계획한다', () => {
    const plan = planFactSync({
      ...BASE,
      symbols: ['005930'],
      coveredBySymbol: new Map([['005930', [2020, 2021, 2022]]]),
      forcedYearsBySymbol: new Map([['005930', [2022]]]),
      mode: 'INCREMENTAL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([2022]);
  });

  it('forced 연도도 대상 구간 밖이면 계획하지 않는다', () => {
    const plan = planFactSync({
      ...BASE,
      symbols: ['005930'],
      coveredBySymbol: new Map([['005930', [2020, 2021, 2022]]]),
      // 2019 는 fromYear(2020) 앞이다 — 구간 밖 공시 갱신이 계획을 부풀리면 안 된다
      forcedYearsBySymbol: new Map([['005930', [2019]]]),
      mode: 'INCREMENTAL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([]);
    expect(plan.calls).toBe(0);
  });

  it('FULL 은 수집 이력을 무시하고 전 구간을 계획한다', () => {
    const plan = planFactSync({
      ...BASE,
      coveredBySymbol: new Map([['005930', [2020, 2021, 2022]]]),
      mode: 'FULL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([2020, 2021, 2022]);
    expect(plan.yearsBySymbol.get('000660')).toEqual([2020, 2021, 2022]);
  });

  it('INCREMENTAL 은 미수집 연도만 계획한다 — 현재 연도도 covered 면 건너뛴다', () => {
    const plan = planFactSync({
      ...BASE,
      todayKstDate: '2022-08-15',
      coveredBySymbol: new Map([['005930', [2020, 2022]]]),
      mode: 'INCREMENTAL',
    });
    // 예전의 "현재 연도는 항상 다시 읽는다" 규칙은 공시 갱신 감지(forcedYearsBySymbol)
    // 로 대체됐다 — 새 공시가 없으면 covered 현재 연도(2022)를 다시 읽지 않는다.
    expect(plan.yearsBySymbol.get('005930')).toEqual([2021]);
    expect(plan.yearsBySymbol.get('000660')).toEqual([2020, 2021, 2022]);
  });

  it('불연속 수집 이력을 그대로 다룬다', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2018,
      toYear: 2024,
      todayKstDate: '2025-06-01',
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
      todayKstDate: AFTER_ALL_YEARS,
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
    todayKstDate: '2027-06-01',
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
    // 3년 × 12 + 앵커 2구간 × 4 = 36 + 8 = 44.
    // 같아야 화면 추정치가 거짓말하지 않는다.
    expect(plan.calls).toBe(44);
    expect(plan.estimatedMs).toBe(44 * 120);
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
      todayKstDate: '2030-06-01',
      coveredBySymbol: new Map([['005930', [2020, 2021]]]),
      mode: 'INCREMENTAL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([]);
    expect(plan.shareYearsBySymbol.get('005930')).toEqual([]);
    expect(plan.calls).toBe(0);
    expect(plan.estimatedMs).toBe(0);
  });

  it('호출 수는 종목당 (연도 × 12 + 앵커 4) 이고 예상 시간은 × 120ms 다', () => {
    const plan = planFactSync({ ...BASE, mode: 'FULL' });
    // 종목 2개 × (3년 × 12 + 4) = 80
    expect(plan.calls).toBe(80);
    expect(plan.estimatedMs).toBe(80 * 120);
    expect(plan.overDailyLimit).toBe(false);
  });

  it('일일 한도(40,000) 초과를 표시한다', () => {
    const symbols = Array.from({ length: 200 }, (_, index) => String(index).padStart(6, '0'));
    const plan = planFactSync({
      symbols,
      fromYear: 2000,
      toYear: 2025,
      todayKstDate: '2026-06-01',
      coveredBySymbol: new Map(),
      mode: 'FULL',
    });
    // 200 × (26년 × 12 + 4) = 63,200
    expect(plan.calls).toBe(63_200);
    expect(plan.calls).toBeGreaterThan(DART_DAILY_CALL_LIMIT);
    expect(plan.overDailyLimit).toBe(true);
  });

  it('중복 심볼을 한 번만 계획한다', () => {
    const plan = planFactSync({
      symbols: ['005930', '005930'],
      fromYear: 2022,
      toYear: 2022,
      todayKstDate: AFTER_ALL_YEARS,
      coveredBySymbol: new Map(),
      mode: 'FULL',
    });
    expect(plan.yearsBySymbol.size).toBe(1);
    expect(plan.calls).toBe(16);
  });
});

/**
 * 자본변동 전용 비용(Task 8) — `planFactSync` 의 `calls` 는 재무(`fnlttSinglAcntAll`)
 * 까지 포함하므로 `syncCorporateActions` 가 실제로 쏘는 호출보다 많다. 위저드 게이트
 * 화면은 이 함수의 값을 써야 실행과 추정이 갈리지 않는다(브리프의 함정 1번).
 */
describe('estimateCorporateActionSyncCost', () => {
  it('종목당 (연도 × 4 + shareYears × 4) 다 — 재무 호출을 세지 않는다', () => {
    const plan = planFactSync({ ...BASE, mode: 'FULL' });
    // 종목 2개, 각 3년(2020~2022) + 앵커 1(2019) = shareYears 4개
    // 종목당 3×4 + 4×4 = 28, 2종목이면 56
    expect(plan.calls).toBe(80); // planFactSync 의 값(재무 포함)과는 다르다는 대조군
    const estimate = estimateCorporateActionSyncCost(plan);
    expect(estimate.calls).toBe(56);
    expect(estimate.estimatedMs).toBe(56 * 120);
    expect(estimate.overDailyLimit).toBe(false);
  });

  it('불연속 구간에서도 앵커가 shareYears 에 그대로 반영된다', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2019,
      toYear: 2026,
      todayKstDate: '2027-06-01',
      coveredBySymbol: new Map([['005930', [2021, 2022, 2023, 2024, 2025]]]),
      mode: 'INCREMENTAL',
    });
    // years=[2019,2020,2026](3) shareYears=[2018,2019,2020,2025,2026](5)
    // 3×4 + 5×4 = 32
    const estimate = estimateCorporateActionSyncCost(plan);
    expect(estimate.calls).toBe(32);
    expect(estimate.estimatedMs).toBe(32 * 120);
  });

  it('수집할 것이 없으면 비용도 없다', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2021,
      todayKstDate: '2030-06-01',
      coveredBySymbol: new Map([['005930', [2020, 2021]]]),
      mode: 'INCREMENTAL',
    });
    const estimate = estimateCorporateActionSyncCost(plan);
    expect(estimate.calls).toBe(0);
    expect(estimate.estimatedMs).toBe(0);
    expect(estimate.overDailyLimit).toBe(false);
  });
});
