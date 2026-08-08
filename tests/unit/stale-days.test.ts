import { describe, expect, it } from 'vitest';
import { periodEndTsMs, staleDays } from '../../src/web/features/backtests/stale-days.js';

describe('periodEndTsMs', () => {
  it('기간 종료일을 봉 tsMs 규약(그 거래일 UTC 자정)으로 바꾼다', () => {
    expect(periodEndTsMs('2026-03-31')).toBe(Date.parse('2026-03-31T00:00:00Z'));
  });
});

describe('staleDays', () => {
  it('마지막 확인일이 기간 종료일과 같으면 0이다 — 끝까지 거래된 종목은 표시가 붙지 않는다', () => {
    const endTsMs = periodEndTsMs('2026-03-31');
    expect(staleDays(endTsMs, endTsMs)).toBe(0);
  });

  it('마지막 확인일이 기간 종료일보다 앞서면 그 일수를 돌려준다', () => {
    const endTsMs = periodEndTsMs('2026-03-31');
    const lastPriceTsMs = periodEndTsMs('2026-03-25'); // 6일 이른 거래정지
    expect(staleDays(lastPriceTsMs, endTsMs)).toBe(6);
  });

  it('마지막 확인일이 기간 종료일 이후여도(시계 오차 등) 음수를 돌려주지 않는다', () => {
    const endTsMs = periodEndTsMs('2026-03-31');
    const lastPriceTsMs = endTsMs + 3_600_000;
    expect(staleDays(lastPriceTsMs, endTsMs)).toBe(0);
  });
});
