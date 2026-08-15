import { describe, expect, it } from 'vitest';
import {
  sameUniverseParams,
  type PreviewParams,
} from '../../src/web/features/backtests/universe-rule-step.js';

const baseline: PreviewParams = {
  strategyId: 'range-breakout',
  parameters: { b: 2, nested: { z: true, a: false }, a: 1 },
  period: { from: '2026-01-01', to: '2026-12-31' },
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 }],
    rebalanceInterval: { value: 1, unit: 'MONTH' },
  },
};

describe('sameUniverseParams', () => {
  it('객체 키 순서가 달라도 서버 준비 hash와 같이 동일하다고 본다', () => {
    expect(sameUniverseParams(baseline, {
      ...baseline,
      parameters: { a: 1, nested: { a: false, z: true }, b: 2 },
    })).toBe(true);
  });

  it('기간·규칙·전략·파라미터 변경은 미리보기를 무효화한다', () => {
    expect(sameUniverseParams(baseline, { ...baseline, period: { ...baseline.period, to: '2027-01-01' } })).toBe(false);
    expect(sameUniverseParams(baseline, { ...baseline, strategyId: 'other' })).toBe(false);
    expect(sameUniverseParams(baseline, { ...baseline, parameters: { a: 2 } })).toBe(false);
    expect(sameUniverseParams(baseline, {
      ...baseline,
      universeRule: { ...baseline.universeRule, stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 99 }] },
    })).toBe(false);
  });
});
