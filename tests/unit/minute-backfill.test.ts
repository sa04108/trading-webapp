import { describe, expect, it } from 'vitest';
import {
  MINUTE_BACKFILL_MAX_MONTHS,
  MINUTE_BACKFILL_SYMBOL_YEARS,
  estimateMinuteBackfillBars,
  minuteBackfillFloorTsMs,
  recommendedMinuteMonths,
} from '../../src/server/modules/market-data/domain/minute-backfill.js';

describe('MINUTE_BACKFILL_MAX_MONTHS / MINUTE_BACKFILL_SYMBOL_YEARS (상수)', () => {
  it('하드 상한은 24개월(2년)이다', () => {
    expect(MINUTE_BACKFILL_MAX_MONTHS).toBe(24);
  });

  it('권장치 계산용 예산은 종목당 20년이다', () => {
    expect(MINUTE_BACKFILL_SYMBOL_YEARS).toBe(20);
  });
});

describe('recommendedMinuteMonths (종목 수 기준 권장 기간)', () => {
  it('종목 1개면 예산이 240개월이지만 하드 상한 24개월로 잘린다', () => {
    expect(recommendedMinuteMonths(1)).toBe(24);
  });

  it('종목 10개도 여전히 상한(24개월)에 걸린다', () => {
    expect(recommendedMinuteMonths(10)).toBe(24);
  });

  it('종목 20개면 예산과 상한이 맞아떨어져 12개월', () => {
    expect(recommendedMinuteMonths(20)).toBe(12);
  });

  it('종목 40개면 6개월', () => {
    expect(recommendedMinuteMonths(40)).toBe(6);
  });

  it('종목 1000개면 최소 1개월까지만 내려간다', () => {
    expect(recommendedMinuteMonths(1000)).toBe(1);
  });

  it('종목 0개는 0으로 나누지 않고 상한(24개월)을 반환한다', () => {
    expect(recommendedMinuteMonths(0)).toBe(24);
  });
});

describe('minuteBackfillFloorTsMs (분봉 백필 하한 — 달력 월 단위)', () => {
  it('2026-07-30 기준 정확히 2년 전인 2024-07-30 UTC 자정과 같은 일자에 닿는다', () => {
    const nowMs = Date.UTC(2026, 6, 30, 3, 15, 0); // 2026-07-30 03:15 UTC
    const floor = minuteBackfillFloorTsMs(nowMs);
    const floorDate = new Date(floor);
    expect(floorDate.getUTCFullYear()).toBe(2024);
    expect(floorDate.getUTCMonth()).toBe(6); // 7월 (0-indexed)
    expect(floorDate.getUTCDate()).toBe(30);
    expect(floorDate.getUTCHours()).toBe(3);
    expect(floorDate.getUTCMinutes()).toBe(15);
    expect(floor).toBe(Date.UTC(2024, 6, 30, 3, 15, 0));
  });

  it('30일 근사가 아니라 달력 월 산술이다 — 31일 있는 달에서도 같은 일자를 유지한다', () => {
    const nowMs = Date.UTC(2026, 0, 31, 0, 0, 0); // 2026-01-31
    const floor = minuteBackfillFloorTsMs(nowMs);
    expect(floor).toBe(Date.UTC(2024, 0, 31, 0, 0, 0));
  });
});

describe('estimateMinuteBackfillBars (예상 봉 수 추정)', () => {
  it('KR 세션(390분/일) 기준 24개월 예상치', () => {
    // 10 종목 × 390분/일 × round(24개월 × 21거래일/월)
    expect(estimateMinuteBackfillBars(10, 390, 24)).toBe(10 * 390 * 504);
  });

  it('종목 1개 · 1개월', () => {
    expect(estimateMinuteBackfillBars(1, 390, 1)).toBe(390 * 21);
  });

  it('종목 0개면 0봉', () => {
    expect(estimateMinuteBackfillBars(0, 390, 24)).toBe(0);
  });
});
