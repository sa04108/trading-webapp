import { describe, expect, it } from 'vitest';
import {
  addMonths,
  buildMonthGrid,
  formatMonth,
  monthOf,
} from '../../src/web/lib/calendar-month.js';

describe('monthOf', () => {
  it('ISO 날짜에서 달만 떼어낸다', () => {
    expect(monthOf('2026-08-09')).toBe('2026-08');
  });
});

describe('addMonths', () => {
  it('같은 해 안에서 더한다', () => {
    expect(addMonths('2026-03', 2)).toBe('2026-05');
  });

  it('해를 넘겨 더한다', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
  });

  it('해를 넘겨 뺀다', () => {
    expect(addMonths('2026-02', -3)).toBe('2025-11');
  });

  it('1월에서 한 달 빼면 전해 12월이다', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
});

describe('formatMonth', () => {
  it('앞의 0을 떼고 한국어로 쓴다', () => {
    expect(formatMonth('2026-08')).toBe('2026년 8월');
  });
});

describe('buildMonthGrid', () => {
  it('6주 격자를 채운다', () => {
    expect(buildMonthGrid('2026-08')).toHaveLength(42);
  });

  it('일요일에서 시작한다', () => {
    for (const month of ['2026-08', '2026-02', '2025-11']) {
      const first = buildMonthGrid(month)[0]!;
      expect(new Date(`${first.date}T00:00:00Z`).getUTCDay()).toBe(0);
    }
  });

  it('그 달 1일이 앞 여백 바로 뒤에 온다', () => {
    // 2026-08-01 은 토요일 — 앞에 일~금 6칸이 이전 달로 채워진다
    const cells = buildMonthGrid('2026-08');
    const firstInside = cells.findIndex((cell) => !cell.outside);
    expect(firstInside).toBe(6);
    expect(cells[firstInside]!.date).toBe('2026-08-01');
    expect(cells[0]!.date).toBe('2026-07-26');
  });

  it('그 달 날짜만 outside 가 아니다', () => {
    const inside = buildMonthGrid('2026-08').filter((cell) => !cell.outside);
    expect(inside).toHaveLength(31);
    expect(inside[0]!.date).toBe('2026-08-01');
    expect(inside.at(-1)!.date).toBe('2026-08-31');
  });

  it('윤년 2월은 29일까지다', () => {
    const inside = buildMonthGrid('2024-02').filter((cell) => !cell.outside);
    expect(inside).toHaveLength(29);
    expect(inside.at(-1)!.date).toBe('2024-02-29');
  });

  it('해를 넘는 여백도 이어진다', () => {
    const cells = buildMonthGrid('2026-01');
    expect(cells[0]!.date).toBe('2025-12-28');
    expect(cells.at(-1)!.date).toBe('2026-02-07');
  });

  it('day 는 그 칸 날짜의 일자다', () => {
    for (const cell of buildMonthGrid('2026-08')) {
      expect(cell.day).toBe(Number(cell.date.slice(8)));
    }
  });
});
