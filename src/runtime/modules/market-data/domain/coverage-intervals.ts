import { addCalendarDays } from "./kst-date.js";

export interface CoverageInterval {
  readonly startDate: string;
  readonly endDate: string;
  readonly syncedAtMs: number;
}

/**
 * 실행 버전별로 겹친 수집 이력을 읽기 시점에 합친다.
 * 원본 행·출처·수집 시각은 변경하지 않으며, 실제 미수집 날짜를 연결하지 않는다.
 */
export function unionCoverageIntervals(
  intervals: readonly CoverageInterval[],
): { startDate: string; endDate: string; syncedAtMs: number }[] {
  const result: { startDate: string; endDate: string; syncedAtMs: number }[] = [];
  for (const interval of [...intervals].sort(
    (left, right) => left.startDate.localeCompare(right.startDate) || left.endDate.localeCompare(right.endDate),
  )) {
    if (interval.startDate > interval.endDate) {
      throw new Error("수집 이력의 시작일이 종료일보다 늦습니다.");
    }
    const previous = result[result.length - 1];
    if (previous === undefined || interval.startDate > addCalendarDays(previous.endDate, 1)) {
      result.push({ startDate: interval.startDate, endDate: interval.endDate, syncedAtMs: interval.syncedAtMs });
      continue;
    }
    if (interval.endDate > previous.endDate) previous.endDate = interval.endDate;
    previous.syncedAtMs = Math.max(previous.syncedAtMs, interval.syncedAtMs);
  }
  return result;
}

export function coverageContainsRange(
  intervals: readonly CoverageInterval[],
  from: string,
  to: string,
): boolean {
  if (from > to) return true;
  return unionCoverageIntervals(intervals).some(
    (interval) => interval.startDate <= from && interval.endDate >= to,
  );
}
