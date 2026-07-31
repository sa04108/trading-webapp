import { describe, expect, it } from 'vitest';
import { formatRelativeTime, timeframeLabel } from '../../src/web/lib/format.js';

describe('timeframeLabel', () => {
  it('봉 주기 코드를 한국어로 표기한다', () => {
    expect(timeframeLabel('1m')).toBe('1분봉');
    expect(timeframeLabel('1h')).toBe('1시간봉');
    expect(timeframeLabel('1d')).toBe('일봉');
  });

  it('모르는 코드는 그대로 돌려준다', () => {
    expect(timeframeLabel('5m')).toBe('5m');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0);
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  it('한 번도 수집되지 않았으면 없음', () => {
    expect(formatRelativeTime(null, now)).toBe('없음');
    expect(formatRelativeTime(undefined, now)).toBe('없음');
  });

  it('1분 미만은 방금', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('방금');
  });

  it('분·시간·일 단위로 올라간다', () => {
    expect(formatRelativeTime(now - 5 * MINUTE, now)).toBe('5분 전');
    expect(formatRelativeTime(now - 3 * HOUR, now)).toBe('3시간 전');
    expect(formatRelativeTime(now - 23 * HOUR, now)).toBe('23시간 전');
    expect(formatRelativeTime(now - 25 * HOUR, now)).toBe('1일 전');
    expect(formatRelativeTime(now - 30 * DAY, now)).toBe('30일 전');
  });

  it('경계에서 단위가 바뀐다 — 60분은 1시간 전, 24시간은 1일 전', () => {
    expect(formatRelativeTime(now - 60 * MINUTE, now)).toBe('1시간 전');
    expect(formatRelativeTime(now - 24 * HOUR, now)).toBe('1일 전');
  });

  it('미래 시각은 방금으로 접는다 — 시계가 어긋나도 "-3일 전" 을 쓰지 않는다', () => {
    expect(formatRelativeTime(now + 3 * DAY, now)).toBe('방금');
  });

  it('0 은 없음 — 수집 시각이 0 인 잡은 존재하지 않는다', () => {
    expect(formatRelativeTime(0, now)).toBe('없음');
  });
});
