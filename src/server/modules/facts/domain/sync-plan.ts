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
 * 자본변동 앵커용 추가 호출 (종목당 1회, 4개 보고서).
 * `fetchCorporateActions` 는 `sharesBefore()` 로 이벤트 직전 발행주식수를 찾아 분할
 * 비율을 만든다. 대상 연도만 읽으면 그 연도 연초 이벤트의 앵커가 없어 비율이 조용히
 * gap 이 된다 — 직전 1년의 주식총수를 함께 읽어 앵커를 확보한다.
 */
export const DART_SHARE_ANCHOR_CALLS = 4;

/**
 * RestClient 그룹 최소 간격. `dart-fact-source.ts` 가 이 상수를 rate limiter 에 넣는다 —
 * 숫자를 두 곳에 두면 여기만 고쳤을 때 추정치가 실제와 어긋난다.
 */
export const DART_MIN_INTERVAL_MS = 120;

/** DART OpenAPI 일일 호출 한도 */
export const DART_DAILY_CALL_LIMIT = 40_000;

export type FactSyncMode = 'FULL' | 'INCREMENTAL';

export interface FactSyncPlan {
  /** 종목 → 재무·자본변동을 수집할 연도 (오름차순) */
  readonly yearsBySymbol: ReadonlyMap<string, readonly number[]>;
  /** 종목 → 주식총수를 읽을 연도 (= 위 + 직전 1년) */
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

    const first = years[0];
    // 수집할 것이 없으면 앵커도 읽지 않는다 — 0건 종목에 호출을 쓰지 않는다
    const shareYears = first === undefined ? [] : [first - 1, ...years];
    shareYearsBySymbol.set(symbol, shareYears);

    calls += years.length * DART_CALLS_PER_SYMBOL_YEAR;
    if (years.length > 0) calls += DART_SHARE_ANCHOR_CALLS;
  }

  return {
    yearsBySymbol,
    shareYearsBySymbol,
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
