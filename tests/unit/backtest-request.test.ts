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

});

describe('유니버스 상한 (랭킹 전략용 확대)', () => {
  function requestWithSymbols(count: number): Record<string, unknown> {
    return {
      strategyId: 'cross-sectional-momentum',
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

  it('하한 경계 — 1종목은 받고 0종목은 거부한다', () => {
    expect(backtestRequestSchema.safeParse(requestWithSymbols(1)).success).toBe(true);
    expect(backtestRequestSchema.safeParse(requestWithSymbols(0)).success).toBe(false);
  });
});
