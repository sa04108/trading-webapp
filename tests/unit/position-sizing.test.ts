import { describe, expect, it } from 'vitest';
import { riskQuantity } from '../../src/server/modules/strategy/strategies/shared/position-sizing.js';

describe('riskQuantity', () => {
  it('equity × 리스크% ÷ 손절 폭을 내림한다', () => {
    expect(riskQuantity(1_000_000, 1, 300)).toBe(33);
  });

  it('손절 폭이나 자본이 0 이하면 진입 수량을 내지 않는다', () => {
    expect(riskQuantity(1_000_000, 1, 0)).toBe(0);
    expect(riskQuantity(0, 1, 300)).toBe(0);
    expect(riskQuantity(1_000_000, 1, -5)).toBe(0);
  });
});
