import { describe, expect, it } from 'vitest';
import { periodToTsRange } from '../../src/shared/schemas/backtest-request.js';

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
