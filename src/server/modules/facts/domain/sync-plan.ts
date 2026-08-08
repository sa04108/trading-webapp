/**
 * DART 수집 계획 — 무엇을 몇 번 호출하고 얼마나 걸리는지 한 곳에서 정한다.
 *
 * **추정 경로와 실행 경로가 같은 함수를 쓴다.** 화면에 "약 30분" 을 그리는 쪽과 실제로
 * DART 를 때리는 쪽이 규칙을 따로 갖고 있으면, 한쪽만 고쳐졌을 때 사용자에게 보이는
 * 숫자만 조용히 틀려진다 — 틀렸다는 사실도 드러나지 않는다.
 */

/** 종목·연도당 호출: fnlttSinglAcntAll 4 + stockTotqySttus 4 + irdsSttus 1 */
export const DART_CALLS_PER_SYMBOL_YEAR = 9;

/**
 * 앵커 연도 하나당 추가 호출 (4개 보고서).
 *
 * `fetchCorporateActions` 는 `sharesBefore()` 로 이벤트 직전 발행주식수를 찾아 분할
 * 비율을 만든다. 대상 연도만 읽으면 그 연도 연초 이벤트의 앵커가 없어 비율이 조용히
 * gap 이 된다 — 직전 1년의 주식총수를 함께 읽어 앵커를 확보한다.
 *
 * 앵커는 **연속 구간마다** 하나씩 필요하다. 증분 수집의 `years` 는 불연속일 수 있고
 * (예: 이미 2021–2025 를 받은 데이터셋이 2019–2026 을 증분 요청하면 `[2019, 2020, 2026]`),
 * 가장 이른 연도 앞에만 앵커를 두면 2026 이벤트의 분모가 5년 묵은 2020 공시가 된다 —
 * `parseIssuanceRows` 는 분모가 null 일 때만 gap 을 남기므로 이 오류는 **조용히 잘못된
 * 비율**로 나가고 보정가격 전체를 틀리게 만든다. 그래서 종목당 상수가 아니라
 * (연속 구간 수 × 이 값) 이 실제 앵커 비용이다.
 */
export const DART_SHARE_ANCHOR_CALLS = 4;

/**
 * RestClient 그룹 최소 간격. `dart-fact-source.ts` 가 이 상수를 rate limiter 에 넣는다 —
 * 숫자를 두 곳에 두면 여기만 고쳤을 때 추정치가 실제와 어긋난다.
 */
export const DART_MIN_INTERVAL_MS = 120;

/** DART OpenAPI 일일 호출 한도 */
export const DART_DAILY_CALL_LIMIT = 40_000;

/**
 * 자본변동 전용 종목·연도당 호출: irdsSttus 1회다.
 * `syncCorporateActions` 는 `fetchFinancials` 를 부르지 않는다.
 * 그래서 `fnlttSinglAcntAll` 4회가 빠진다(`fact-sync-service.ts` 참고).
 * `DART_CALLS_PER_SYMBOL_YEAR` 는 재무까지 포함한 값이라 이 경로에는 못 쓴다.
 */
export const DART_CORPORATE_ACTION_CALLS_PER_YEAR = 1;

export type FactSyncMode = 'FULL' | 'INCREMENTAL';

export interface FactSyncPlan {
  /** 종목 → 재무·자본변동을 수집할 연도 (오름차순) */
  readonly yearsBySymbol: ReadonlyMap<string, readonly number[]>;
  /** 종목 → 주식총수를 읽을 연도 (= 위 + **각 연도의** 직전 1년) */
  readonly shareYearsBySymbol: ReadonlyMap<string, readonly number[]>;
  readonly calls: number;
  readonly estimatedMs: number;
  readonly overDailyLimit: boolean;
}

export interface PlanFactSyncArgs {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  /** 오늘이 속한 연도 — 분기 보고서가 그 안에서 갱신되므로 증분에서도 다시 읽는다 */
  readonly currentYear: number;
  readonly coveredBySymbol: ReadonlyMap<string, readonly number[]>;
  readonly mode: FactSyncMode;
}

export function planFactSync(args: PlanFactSyncArgs): FactSyncPlan {
  const target: number[] = [];
  for (let year = args.fromYear; year <= args.toYear; year += 1) target.push(year);

  const yearsBySymbol = new Map<string, readonly number[]>();
  const shareYearsBySymbol = new Map<string, readonly number[]>();
  let calls = 0;

  // 같은 종목이 두 번 들어와도 한 번만 계획한다 — 호출 수가 부풀면 예상 시간도 부푼다
  for (const symbol of new Set(args.symbols)) {
    const years =
      args.mode === 'FULL' ? target : incrementalYears(target, args.coveredBySymbol.get(symbol) ?? [], args.currentYear);
    yearsBySymbol.set(symbol, years);

    // 수집할 것이 없으면 앵커도 읽지 않는다 — 0건 종목에 호출을 쓰지 않는다
    const shareYears = anchoredShareYears(years);
    shareYearsBySymbol.set(symbol, shareYears);

    calls += years.length * DART_CALLS_PER_SYMBOL_YEAR;
    // 앵커 수 = 연속 구간 수 = |shareYears| - |years|. 연속 구간이 하나면 (첫 실행·
    // 단일 연도 증분) 종전과 같은 4회다 — 불연속일 때만 늘어난다.
    calls += (shareYears.length - years.length) * DART_SHARE_ANCHOR_CALLS;
  }

  return {
    yearsBySymbol,
    shareYearsBySymbol,
    calls,
    estimatedMs: calls * DART_MIN_INTERVAL_MS,
    overDailyLimit: calls > DART_DAILY_CALL_LIMIT,
  };
}

/**
 * 대상 연도 + 각 연도의 직전 1년 (오름차순, 중복 제거).
 *
 * 연속 구간에서는 앞의 한 해만 늘어나 종전과 같지만, 불연속 구간에서는 구간마다 앵커가
 * 생긴다 — `sharesBefore()` 가 구멍 건너편의 낡은 공시를 분모로 집지 않게 한다.
 */
function anchoredShareYears(years: readonly number[]): number[] {
  const withAnchors = new Set<number>();
  for (const year of years) {
    withAnchors.add(year - 1);
    withAnchors.add(year);
  }
  return [...withAnchors].sort((a, b) => a - b);
}

export interface CorporateActionSyncEstimate {
  readonly calls: number;
  readonly estimatedMs: number;
  readonly overDailyLimit: boolean;
}

/**
 * 자본변동 전용 수집 비용이다. 위저드 게이트 화면(Task 8)의
 * "예상 호출·예상 시간" 이 여기서 나온다.
 *
 * `plan.calls` 를 그대로 쓰지 않는다.
 * 그 값은 재무까지 포함한 종목당 9회 공식이다.
 * `syncCorporateActions` 는 `fetchFinancials` 를 건너뛴다.
 * 그래서 그 값은 실제보다 연도당 4회씩 많게 잡힌다.
 *
 * `plan.yearsBySymbol`·`plan.shareYearsBySymbol` 은 그대로 재사용한다.
 * 증분·앵커 연도 선택 규칙은 자본변동 전용이라도 달라지지 않는다.
 * 여기서 다시 계산하면 두 계획이 갈라질 여지만 생긴다.
 * 승수만 실제 호출 횟수에 맞춰 다시 곱한다.
 * 연도당 irdsSttus 1회, shareYear 당 stockTotqySttus 4회다
 * (`dart-fact-source.ts` 의 `fetchCorporateActions` 참고).
 */
export function estimateCorporateActionSyncCost(plan: FactSyncPlan): CorporateActionSyncEstimate {
  let calls = 0;
  for (const years of plan.yearsBySymbol.values()) {
    calls += years.length * DART_CORPORATE_ACTION_CALLS_PER_YEAR;
  }
  for (const shareYears of plan.shareYearsBySymbol.values()) {
    calls += shareYears.length * DART_SHARE_ANCHOR_CALLS;
  }
  return {
    calls,
    estimatedMs: calls * DART_MIN_INTERVAL_MS,
    overDailyLimit: calls > DART_DAILY_CALL_LIMIT,
  };
}

function incrementalYears(
  target: readonly number[],
  covered: readonly number[],
  currentYear: number,
): number[] {
  const coveredSet = new Set(covered);
  return target.filter((year) => year === currentYear || !coveredSet.has(year));
}
