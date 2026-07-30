import { describe, expect, it } from 'vitest';
import { riskQuantity } from '../../src/server/modules/strategy/strategies/shared/position-sizing.js';
import {
  confirmEntry,
  holdLimitReached,
  newHolding,
  updateTrail,
} from '../../src/server/modules/strategy/strategies/shared/trailing-stop.js';

describe('riskQuantity', () => {
  it('equity × 리스크% ÷ 손절 폭, 내림', () => {
    // 1,000,000 × 1% ÷ 300 = 33.33 → 33
    expect(riskQuantity(1_000_000, 1, 300)).toBe(33);
  });

  it('손절 폭이나 자본이 0 이하면 0 — 진입하지 않는다', () => {
    expect(riskQuantity(1_000_000, 1, 0)).toBe(0);
    expect(riskQuantity(0, 1, 300)).toBe(0);
    expect(riskQuantity(1_000_000, 1, -5)).toBe(0);
  });
});

describe('trailing-stop', () => {
  it('체결 확인 시 실제 진입가 기준으로 스톱을 고정한다', () => {
    const holding = newHolding();
    holding.entryAtr = 100;
    confirmEntry(holding, 10_000, 2);
    expect(holding.stopLevel).toBe(9_800); // 10000 − 2×100
  });

  it('고점 갱신 시 스톱이 따라 오르고, 내려가지는 않는다', () => {
    const holding = newHolding();
    holding.entryAtr = 100;
    confirmEntry(holding, 10_000, 2);
    updateTrail(holding, 10_500, 2); // 고점 10500 → stop = max(9800, 10500−200)
    expect(holding.stopLevel).toBe(10_300);
    updateTrail(holding, 10_100, 2); // 고점 갱신 아님 — 스톱 유지
    expect(holding.stopLevel).toBe(10_300);
  });

  it('entryAtr 없이 confirmEntry 는 no-op — 잘못된 순서에 스톱을 만들지 않는다', () => {
    const holding = newHolding();
    confirmEntry(holding, 10_000, 2);
    expect(holding.stopLevel).toBeNull();
  });

  it('holdLimitReached: maxHoldBars 미지정이면 항상 false', () => {
    const holding = newHolding();
    holding.barsHeld = 9_999;
    expect(holdLimitReached(holding, undefined)).toBe(false);
    expect(holdLimitReached(holding, 9_999)).toBe(true);
    expect(holdLimitReached(holding, 10_000)).toBe(false);
  });
});
