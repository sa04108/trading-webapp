/**
 * 분봉 백필 상한 (설계 2026-07-30-minute-backfill-cap-design.md).
 * 분봉은 종목·기간에 비례해 폭발하므로 수집 자체를 2년으로 묶는다.
 */
export const MINUTE_BACKFILL_MAX_MONTHS = 24;

/**
 * 권장 기간 계산에만 쓰는 예산(종목-년). 실제 수집 상한이 아니다 — 실제 상한은
 * MINUTE_BACKFILL_MAX_MONTHS 로 고정이고, 이 값은 "한 번의 백테스트가 감당할 수
 * 있는" 권장 기간을 종목 수에 반비례해 안내하는 데만 쓴다.
 *
 * 값의 근거: KR 정규장 390봉/일 × 약 245거래일 ≈ 95,500봉/종목·년 이므로
 * 20 종목-년 ≈ 191만봉 ≈ MAX_BACKTEST_BARS(200만봉).
 */
export const MINUTE_BACKFILL_SYMBOL_YEARS = 20;

/**
 * 종목 수 기준 권장 분봉 수집 기간(개월). 종목이 늘수록 한 번의 백테스트가 감당할
 * 수 있는 기간은 줄어든다 — MINUTE_BACKFILL_SYMBOL_YEARS 예산을 종목 수로 나눈다.
 * 하드 상한(MINUTE_BACKFILL_MAX_MONTHS)을 넘지 않고, 최소 1개월은 보장한다.
 *
 * symbolCount<=0 은 0으로 나누는 대신 1종목으로 취급해 상한(24개월)을 반환한다 —
 * 종목이 아직 없는 상태에서 "권장 기간을 계산할 수 없음"보다 상한을 보여주는 쪽이
 * 화면에서 다루기 쉽고, 종목이 채워지면 실제 값으로 자연히 좁혀진다.
 */
export function recommendedMinuteMonths(symbolCount: number): number {
  const denominator = symbolCount > 0 ? symbolCount : 1;
  const months = Math.floor((MINUTE_BACKFILL_SYMBOL_YEARS * 12) / denominator);
  return Math.min(Math.max(months, 1), MINUTE_BACKFILL_MAX_MONTHS);
}

/**
 * 분봉 백필이 내려갈 하한 타임스탬프. 달력 월 단위로 MINUTE_BACKFILL_MAX_MONTHS 개월
 * 전 — 30일 근사가 아니라 UTC 월 산술이라 말일 근처에서도 날짜가 밀리지 않는다.
 * 종목 수를 받지 않는다 — 수집 상한은 종목 수와 무관하게 항상 고정이다.
 */
export function minuteBackfillFloorTsMs(nowMs: number): number {
  const floor = new Date(nowMs);
  floor.setUTCMonth(floor.getUTCMonth() - MINUTE_BACKFILL_MAX_MONTHS);
  return floor.getTime();
}

/** 월평균 거래일. 공휴일 캘린더 없이 쓰는 근사치 — 상한 초과 여부 판정용이라 과대추정이 안전한 방향이다. */
const AVERAGE_TRADING_DAYS_PER_MONTH = 21;

/**
 * coverage 없이(수집 전) 순수 산술로만 어림하는 분봉 봉 수 예상치.
 * symbolCount × sessionMinutesPerDay × round(months × 월평균 거래일).
 */
export function estimateMinuteBackfillBars(
  symbolCount: number,
  sessionMinutesPerDay: number,
  months: number,
): number {
  const tradingDays = Math.round(months * AVERAGE_TRADING_DAYS_PER_MONTH);
  return symbolCount * sessionMinutesPerDay * tradingDays;
}
