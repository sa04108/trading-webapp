import { describe, expect, it } from 'vitest';
import { computeHourlyCoverage } from '../../src/server/modules/market-data/domain/coverage.js';
import {
  KR_SESSION,
  hourlyBucketStarts,
} from '../../src/server/modules/market-data/domain/exchange-session.js';

const MONDAY_0900_KST_UTC = Date.UTC(2026, 6, 6, 0, 0);
const DAY_MS = 86_400_000;

function dayBars(dayOffset: number): number[] {
  return hourlyBucketStarts(KR_SESSION).map(
    (minute) => MONDAY_0900_KST_UTC + dayOffset * DAY_MS + (minute - KR_SESSION.openMinutes) * 60_000,
  );
}

describe('computeHourlyCoverage (스펙 §13 누락 탐지)', () => {
  it('reports full coverage with no gaps', () => {
    const bars = [...dayBars(0), ...dayBars(1)]; // 월+화
    const result = computeHourlyCoverage(bars, KR_SESSION);
    expect(result.barCount).toBe(14);
    expect(result.expectedBarCount).toBe(14);
    expect(result.missingRanges).toEqual([]);
  });

  it('detects a missing bar as a gap range', () => {
    const bars = [...dayBars(0), ...dayBars(1)];
    const missingTs = bars[9]!; // 화요일 11시 부근
    const withGap = bars.filter((ts) => ts !== missingTs);

    const result = computeHourlyCoverage(withGap, KR_SESSION);
    expect(result.barCount).toBe(13);
    expect(result.expectedBarCount).toBe(14);
    expect(result.missingRanges).toEqual([{ fromTsMs: missingTs, toTsMs: missingTs }]);
  });

  it('does not count weekends as expected bars', () => {
    // 금(dayOffset 4) + 월(dayOffset 7): 주말은 기대 봉에서 제외
    const bars = [...dayBars(4), ...dayBars(7)];
    const result = computeHourlyCoverage(bars, KR_SESSION);
    expect(result.expectedBarCount).toBe(14);
    expect(result.missingRanges).toEqual([]);
  });

  it('handles empty input', () => {
    const result = computeHourlyCoverage([], KR_SESSION);
    expect(result.barCount).toBe(0);
    expect(result.firstTsMs).toBeNull();
  });
});
