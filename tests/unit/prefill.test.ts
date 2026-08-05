import { describe, expect, it } from 'vitest';
import { requestToFormState } from '../../src/web/features/backtests/prefill.js';
import type { BacktestRequestBody } from '../../src/web/features/backtests/types.js';

const request: BacktestRequestBody = {
  strategyId: 'range-breakout',
  parameters: { lookbackBars: 10, atrPeriod: 5 },
  universeRule: { markets: ['KOSPI'], topN: 200, sortKey: 'MKTCAP' },
  period: { from: '2025-07-27', to: '2026-07-24' },
  capital: { initialCash: 10_000_000, currency: 'KRW' },
  execution: {
    fillTiming: 'NEXT_BAR_OPEN',
    commissionProfileId: 'kr-equity-default',
    slippageProfileId: 'fixed-5bps',
  },
  risk: { maxPositions: 5 },
  randomSeed: 42,
};

const catalog = {
  strategyIds: ['range-breakout'],
};

describe('requestToFormState', () => {
  it('모든 값을 폼 상태로 옮긴다', () => {
    const { state, notes } = requestToFormState(request, catalog);
    expect(notes).toEqual([]);
    expect(state.strategyId).toBe('range-breakout');
    expect(state.parameters).toEqual({ lookbackBars: '10', atrPeriod: '5' });
    expect(state.universeRule).toEqual({ markets: ['KOSPI'], topN: 200, sortKey: 'MKTCAP' });
    expect(state.from).toBe('2025-07-27');
    expect(state.to).toBe('2026-07-24');
    expect(state.initialCash).toBe('10000000');
    expect(state.maxPositions).toBe('5');
    expect(state.randomSeed).toBe('42');
  });

  it('timeframe 을 왕복시킨다 — 미지정은 빈 문자열(유니버스 기본)', () => {
    const explicit = requestToFormState({ ...request, timeframe: '1m' }, catalog);
    expect(explicit.state.timeframe).toBe('1m');

    const unspecified = requestToFormState(request, catalog);
    expect(unspecified.state.timeframe).toBe('');
  });

  it('전략이 사라지면 전략과 파라미터를 비우고 알린다', () => {
    const { state, notes } = requestToFormState(request, { strategyIds: [] });
    expect(state.strategyId).toBeNull();
    expect(state.parameters).toEqual({});
    expect(notes.some((n: string) => n.includes('range-breakout'))).toBe(true);
    // 전략이 사라져도 유니버스 규칙은 그대로 옮긴다 — 규칙은 전략과 무관한 값이다
    expect(state.universeRule).toEqual(request.universeRule);
  });
});
