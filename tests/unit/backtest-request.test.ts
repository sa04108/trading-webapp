import { describe, expect, it } from 'vitest';
import {
  backtestRequestSchema,
  periodToTsRange,
} from '../../src/shared/schemas/backtest-request.js';

describe('periodToTsRange', () => {
  it('구간은 to 일자의 끝까지 포함한다 (UTC)', () => {
    const { fromTsMs, toTsMs } = periodToTsRange({ from: '2025-07-27', to: '2026-07-24' });
    expect(fromTsMs).toBe(Date.UTC(2025, 6, 27, 0, 0, 0, 0));
    expect(toTsMs).toBe(Date.UTC(2026, 6, 24, 23, 59, 59, 999));
  });

  it('to 일자 UTC 자정의 봉(KST 09:00 일봉)을 포함한다', () => {
    const { fromTsMs, toTsMs } = periodToTsRange({ from: '2026-07-24', to: '2026-07-24' });
    const bar = Date.UTC(2026, 6, 24);
    expect(bar).toBeGreaterThanOrEqual(fromTsMs);
    expect(bar).toBeLessThanOrEqual(toTsMs);
  });
});

describe('유니버스 상한 (랭킹 전략용 확대)', () => {
  function requestWithSymbols(count: number): Record<string, unknown> {
    return {
      strategyId: 'cross-sectional-momentum',
      strategyVersion: '1.0.0',
      parameters: {},
      datasetId: 'ds-1',
      universe: {
        type: 'SYMBOLS',
        symbols: Array.from({ length: count }, (_, index) =>
          String(index + 1).padStart(6, '0'),
        ),
      },
      period: { from: '2020-01-01', to: '2025-12-31' },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-default',
        slippageProfileId: 'kr-default',
      },
      risk: { maxPositions: 20 },
    };
  }

  it('200종목을 받는다', () => {
    expect(backtestRequestSchema.safeParse(requestWithSymbols(200)).success).toBe(true);
  });

  it('201종목은 거부한다', () => {
    expect(backtestRequestSchema.safeParse(requestWithSymbols(201)).success).toBe(false);
  });

  it('기존 상한(50) 이하 요청은 그대로 유효하다', () => {
    expect(backtestRequestSchema.safeParse(requestWithSymbols(50)).success).toBe(true);
    expect(backtestRequestSchema.safeParse(requestWithSymbols(1)).success).toBe(true);
  });

  it('0종목은 여전히 거부한다', () => {
    expect(backtestRequestSchema.safeParse(requestWithSymbols(0)).success).toBe(false);
  });
});
