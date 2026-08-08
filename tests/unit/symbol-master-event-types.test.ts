import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPE_FILTER_OPTIONS,
  eventTypeLabel,
  filterEventsByType,
} from '../../src/web/features/symbol-master/event-types.js';

const EVENTS = [
  { id: '2023-01-01:A:LISTED', eventType: 'LISTED' },
  { id: '2023-01-02:A:SHARES_CHANGED', eventType: 'SHARES_CHANGED' },
  { id: '2023-01-03:A:DELISTED', eventType: 'DELISTED' },
  { id: '2023-01-04:A:SHARES_CHANGED', eventType: 'SHARES_CHANGED' },
];

describe('eventTypeLabel', () => {
  it('알려진 종류는 태그 문구로 바꾼다', () => {
    expect(eventTypeLabel('SHARES_CHANGED')).toBe('주식수 변경');
    expect(eventTypeLabel('DELISTED')).toBe('상장폐지');
    expect(eventTypeLabel('SHORT_CODE_CHANGED')).toBe('단축코드 변경');
    expect(eventTypeLabel('LISTED_DATE_CHANGED')).toBe('상장일 변경');
  });

  it('모르는 종류는 원문을 그대로 쓴다', () => {
    expect(eventTypeLabel('SPLIT')).toBe('SPLIT');
  });
});

describe('filterEventsByType', () => {
  it('ALL 은 전부 남긴다', () => {
    expect(filterEventsByType(EVENTS, 'ALL')).toHaveLength(4);
  });

  it('고른 종류만 남긴다', () => {
    expect(filterEventsByType(EVENTS, 'SHARES_CHANGED').map((event) => event.id)).toEqual([
      '2023-01-02:A:SHARES_CHANGED',
      '2023-01-04:A:SHARES_CHANGED',
    ]);
  });

  it('해당 종류가 없으면 빈 목록이다', () => {
    expect(filterEventsByType(EVENTS, 'NAME_CHANGED')).toEqual([]);
  });
});

describe('EVENT_TYPE_FILTER_OPTIONS', () => {
  it('첫 항목은 전체 보기다', () => {
    expect(EVENT_TYPE_FILTER_OPTIONS[0]).toEqual({ value: 'ALL', label: '전체 보기' });
  });

  it('나머지는 태그 문구와 같은 라벨을 쓴다', () => {
    const shares = EVENT_TYPE_FILTER_OPTIONS.find((option) => option.value === 'SHARES_CHANGED');
    expect(shares?.label).toBe(eventTypeLabel('SHARES_CHANGED'));
  });
});
