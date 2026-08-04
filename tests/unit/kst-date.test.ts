import { describe, expect, it } from 'vitest';
import {
  addCalendarDays, basDdToIso, isoToBasDd, KRX_DATA_EPOCH, kstDateOf, kstEndOfDayMs, kstHourOf,
} from '../../src/server/modules/market-data/domain/kst-date.js';

describe('kst-date', () => {
  it('UTC 자정 직전은 KST 다음 날이다', () => {
    // 2026-08-02T23:00:00Z = KST 2026-08-03 08:00
    expect(kstDateOf(Date.UTC(2026, 7, 2, 23, 0, 0))).toBe('2026-08-03');
    expect(kstHourOf(Date.UTC(2026, 7, 2, 23, 0, 0))).toBe(8);
  });

  it('달력일 가감은 월 경계를 넘는다', () => {
    expect(addCalendarDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(addCalendarDays('2024-12-31', 1)).toBe('2025-01-01');
  });

  it('basDd 변환은 왕복한다', () => {
    expect(isoToBasDd('2025-01-02')).toBe('20250102');
    expect(basDdToIso('20250102')).toBe('2025-01-02');
  });

  it('KRX 공식 제공 시작일은 2010-01-04 다', () => {
    expect(KRX_DATA_EPOCH).toBe('2010-01-04');
  });
});

describe('kstEndOfDayMs', () => {
  it('그 날짜 KST 의 마지막 ms 다 — 1ms 뒤는 다음 날짜다', () => {
    const end = kstEndOfDayMs('2020-06-15');
    expect(kstDateOf(end)).toBe('2020-06-15');
    expect(kstDateOf(end + 1)).toBe('2020-06-16');
  });

  it('DART 접수일 18:00 KST 공시가 그 날짜 컷오프에 포함된다', () => {
    // 2020-06-15 18:00 KST = 2020-06-15 09:00 UTC
    const filing = Date.parse('2020-06-15T09:00:00Z');
    expect(filing).toBeLessThanOrEqual(kstEndOfDayMs('2020-06-15'));
  });
});
