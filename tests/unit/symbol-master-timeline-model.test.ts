import { describe, expect, it } from 'vitest';
import {
  buildTimelineSegments,
  dateToPct,
  pctToDate,
} from '../../src/web/features/symbol-master/timeline-model.js';

// 10일짜리 기준 구간 — 1일이 정확히 10%가 되어 손으로 계산해 검증하기 쉽다.
const rangeStart = '2024-01-01';
const rangeEnd = '2024-01-11';

describe('buildTimelineSegments', () => {
  it('coverage 가 비어 있으면 전체 구간이 covered:false 한 세그먼트다', () => {
    expect(buildTimelineSegments(rangeStart, rangeEnd, [])).toEqual([
      { startPct: 0, endPct: 100, covered: false },
    ]);
  });

  it('가운데만 covered 면 앞·covered·뒤 3세그먼트로 나뉜다', () => {
    const segments = buildTimelineSegments(rangeStart, rangeEnd, [
      { startDate: '2024-01-04', endDate: '2024-01-08' },
    ]);
    expect(segments).toEqual([
      { startPct: 0, endPct: 30, covered: false },
      { startPct: 30, endPct: 70, covered: true },
      { startPct: 70, endPct: 100, covered: false },
    ]);
  });

  it('covered 가 왼쪽 경계에 밀착하면 앞쪽 false 세그먼트 없이 2세그먼트다', () => {
    const segments = buildTimelineSegments(rangeStart, rangeEnd, [
      { startDate: '2024-01-01', endDate: '2024-01-08' },
    ]);
    expect(segments).toEqual([
      { startPct: 0, endPct: 70, covered: true },
      { startPct: 70, endPct: 100, covered: false },
    ]);
  });

  it('covered 가 오른쪽 경계에 밀착하면 뒤쪽 false 세그먼트 없이 2세그먼트다', () => {
    const segments = buildTimelineSegments(rangeStart, rangeEnd, [
      { startDate: '2024-01-04', endDate: '2024-01-11' },
    ]);
    expect(segments).toEqual([
      { startPct: 0, endPct: 30, covered: false },
      { startPct: 30, endPct: 100, covered: true },
    ]);
  });

  it('covered 가 전체 구간과 정확히 같으면 covered:true 한 세그먼트뿐이다', () => {
    const segments = buildTimelineSegments(rangeStart, rangeEnd, [
      { startDate: '2024-01-01', endDate: '2024-01-11' },
    ]);
    expect(segments).toEqual([{ startPct: 0, endPct: 100, covered: true }]);
  });

  it('covered 입력 순서가 뒤섞여 있어도 정렬해서 처리한다', () => {
    const sortedResult = buildTimelineSegments(rangeStart, rangeEnd, [
      { startDate: '2024-01-02', endDate: '2024-01-03' },
      { startDate: '2024-01-08', endDate: '2024-01-09' },
    ]);
    const shuffledResult = buildTimelineSegments(rangeStart, rangeEnd, [
      { startDate: '2024-01-08', endDate: '2024-01-09' },
      { startDate: '2024-01-02', endDate: '2024-01-03' },
    ]);
    expect(shuffledResult).toEqual(sortedResult);
    expect(sortedResult).toEqual([
      { startPct: 0, endPct: 10, covered: false },
      { startPct: 10, endPct: 20, covered: true },
      { startPct: 20, endPct: 70, covered: false },
      { startPct: 70, endPct: 80, covered: true },
      { startPct: 80, endPct: 100, covered: false },
    ]);
  });
});

describe('dateToPct / pctToDate 왕복', () => {
  it('구간 내 날짜를 %로 바꾸고 되돌리면 같은 날짜가 나온다', () => {
    for (const date of ['2024-01-01', '2024-01-04', '2024-01-06', '2024-01-08', '2024-01-11']) {
      const pct = dateToPct(rangeStart, rangeEnd, date);
      expect(pctToDate(rangeStart, rangeEnd, pct)).toBe(date);
    }
  });

  it('시작일은 0%, 종료일은 100%다', () => {
    expect(dateToPct(rangeStart, rangeEnd, rangeStart)).toBe(0);
    expect(dateToPct(rangeStart, rangeEnd, rangeEnd)).toBe(100);
  });

  it('pctToDate 는 날짜 사이 값을 일 단위로 내림한다', () => {
    // 10일 구간에서 35% 는 3.5일 지점 — 일 단위로 내림하면 3일째(2024-01-04)다.
    expect(pctToDate(rangeStart, rangeEnd, 35)).toBe('2024-01-04');
  });

  it('rangeStart==rangeEnd 면 0으로 나누지 않고 고정값을 돌려준다', () => {
    const point = '2024-03-15';
    expect(dateToPct(point, point, point)).toBe(0);
    expect(pctToDate(point, point, 50)).toBe(point);
  });
});
