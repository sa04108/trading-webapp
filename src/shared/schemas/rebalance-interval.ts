import type { BacktestPeriod } from './backtest-request.js';
import type { RebalanceInterval } from './universe-rule.js';

function toUtcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 정규식만으로는 2026-13-45 같은 존재하지 않는 날짜를 걸러내지 못한다 — Date 생성자가
 * 그런 값을 조용히 다음 달로 굴리거나(2026-02-30 → 2026-03-02) NaN 으로 접어, 뒤에서
 * `toISOString()` 이 RangeError 를 던지거나 리밸런스 날짜가 슬그머니 밀린다. 파싱한
 * 날짜를 다시 문자열로 되돌려 원본과 같은지 보는 왕복 검사라야 굴림을 잡는다.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return toIsoDate(date) === value;
}

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addUtcDays(iso: string, days: number): string {
  const date = toUtcDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

export function addRebalanceInterval(
  anchor: string,
  interval: RebalanceInterval,
  multiple = 1,
): string {
  if (interval.unit === 'DAY') return addUtcDays(anchor, interval.value * multiple);
  if (interval.unit === 'WEEK') return addUtcDays(anchor, interval.value * multiple * 7);

  const date = toUtcDate(anchor);
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  const day = date.getUTCDate();
  const addedMonths = interval.unit === 'MONTH'
    ? interval.value * multiple
    : 12 * multiple;
  const totalMonths = monthIndex + addedMonths;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonthIndex = ((totalMonths % 12) + 12) % 12;
  const targetDay = Math.min(day, lastDayOfMonth(targetYear, targetMonthIndex));
  return toIsoDate(new Date(Date.UTC(targetYear, targetMonthIndex, targetDay)));
}

export function computeRebalanceDates(
  period: BacktestPeriod,
  interval: RebalanceInterval,
): string[] {
  const dates: string[] = [];
  for (let multiple = 0; ; multiple += 1) {
    const date = multiple === 0
      ? period.from
      : addRebalanceInterval(period.from, interval, multiple);
    if (date > period.to) return dates;
    dates.push(date);
  }
}

export function rebalanceIntervalFitsPeriod(
  period: BacktestPeriod,
  interval: RebalanceInterval,
): boolean {
  return addRebalanceInterval(period.from, interval) <= addUtcDays(period.to, 1);
}
