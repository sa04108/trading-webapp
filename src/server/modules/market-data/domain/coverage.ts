import type { Timeframe } from './candle.js';
import {
  dayOfWeekFromDayIndex,
  fromLocalTime,
  hourlyBucketStarts,
  toLocalTime,
  type ExchangeSession,
} from './exchange-session.js';

export interface MissingRange {
  readonly fromTsMs: number;
  readonly toTsMs: number;
}

export interface CoverageResult {
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
  readonly barCount: number;
  readonly expectedBarCount: number | null;
  readonly missingRanges: readonly MissingRange[];
}

/**
 * 시간봉 커버리지: 세션 캘린더 기준 기대 봉과 실제 봉을 비교해 누락 구간을 찾는다.
 * 공휴일 캘린더는 MVP 미반영이라 공휴일이 누락으로 보고될 수 있다 (D-006 — UI 에 명시).
 */
export function computeHourlyCoverage(
  presentTsMs: readonly number[],
  session: ExchangeSession,
): CoverageResult {
  if (presentTsMs.length === 0) {
    return { firstTsMs: null, lastTsMs: null, barCount: 0, expectedBarCount: null, missingRanges: [] };
  }

  const present = new Set(presentTsMs);
  const sorted = [...presentTsMs].sort((a, b) => a - b);
  const firstTsMs = sorted[0] as number;
  const lastTsMs = sorted[sorted.length - 1] as number;

  const bucketStarts = hourlyBucketStarts(session);
  const firstLocal = toLocalTime(firstTsMs, session);
  const lastLocal = toLocalTime(lastTsMs, session);

  const missing: MissingRange[] = [];
  let expectedCount = 0;
  let runStart: number | null = null;
  let runEnd: number | null = null;

  for (let dayIndex = firstLocal.dayIndex; dayIndex <= lastLocal.dayIndex; dayIndex += 1) {
    const dayOfWeek = dayOfWeekFromDayIndex(dayIndex);
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    for (const startMinute of bucketStarts) {
      const expectedTs = fromLocalTime(dayIndex, startMinute, session);
      if (expectedTs < firstTsMs || expectedTs > lastTsMs) continue;
      expectedCount += 1;

      if (present.has(expectedTs)) {
        if (runStart !== null && runEnd !== null) {
          missing.push({ fromTsMs: runStart, toTsMs: runEnd });
          runStart = null;
          runEnd = null;
        }
      } else {
        if (runStart === null) runStart = expectedTs;
        runEnd = expectedTs;
      }
    }
  }
  if (runStart !== null && runEnd !== null) {
    missing.push({ fromTsMs: runStart, toTsMs: runEnd });
  }

  return {
    firstTsMs,
    lastTsMs,
    barCount: presentTsMs.length,
    expectedBarCount: expectedCount,
    missingRanges: missing,
  };
}

/** 1m/1d 는 MVP 에서 기대 봉 계산을 생략하고 범위·개수만 보고한다. */
export function computeBasicCoverage(presentTsMs: readonly number[]): CoverageResult {
  if (presentTsMs.length === 0) {
    return { firstTsMs: null, lastTsMs: null, barCount: 0, expectedBarCount: null, missingRanges: [] };
  }
  const sorted = [...presentTsMs].sort((a, b) => a - b);
  return {
    firstTsMs: sorted[0] as number,
    lastTsMs: sorted[sorted.length - 1] as number,
    barCount: presentTsMs.length,
    expectedBarCount: null,
    missingRanges: [],
  };
}

export function computeCoverage(
  timeframe: Timeframe,
  presentTsMs: readonly number[],
  session: ExchangeSession,
): CoverageResult {
  return timeframe === '1h'
    ? computeHourlyCoverage(presentTsMs, session)
    : computeBasicCoverage(presentTsMs);
}
