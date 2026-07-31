import { describe, expect, it } from 'vitest';
import { requestToFormState } from '../../src/web/features/backtests/prefill.js';
import type { BacktestRequestBody } from '../../src/web/features/backtests/types.js';

const request: BacktestRequestBody = {
  strategyId: 'range-breakout',
  strategyVersion: '2.0.0',
  parameters: { lookbackBars: 10, atrPeriod: 5 },
  datasetId: 'ds_1',
  universe: { type: 'SYMBOLS', symbols: ['005930', '000660'] },
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
  datasets: [{ id: 'ds_1', symbols: ['005930', '000660'] }],
};

describe('requestToFormState', () => {
  it('모든 값을 문자열 폼 상태로 옮긴다', () => {
    const { state, notes } = requestToFormState(request, catalog);
    expect(notes).toEqual([]);
    expect(state.strategyId).toBe('range-breakout');
    expect(state.parameters).toEqual({ lookbackBars: '10', atrPeriod: '5' });
    expect(state.datasetId).toBe('ds_1');
    expect(state.symbols).toEqual(['005930', '000660']);
    expect(state.from).toBe('2025-07-27');
    expect(state.to).toBe('2026-07-24');
    expect(state.initialCash).toBe('10000000');
    expect(state.maxPositions).toBe('5');
    expect(state.randomSeed).toBe('42');
  });

  it('timeframe 을 왕복시킨다 — 미지정은 빈 문자열(데이터셋 기본)', () => {
    const explicit = requestToFormState({ ...request, timeframe: '1m' }, catalog);
    expect(explicit.state.timeframe).toBe('1m');

    const unspecified = requestToFormState(request, catalog);
    expect(unspecified.state.timeframe).toBe('');
  });

  it('데이터셋이 사라지면 데이터셋·종목을 비우고 알린다', () => {
    const { state, notes } = requestToFormState(request, {
      ...catalog,
      datasets: [],
    });
    expect(state.datasetId).toBeNull();
    expect(state.symbols).toEqual([]);
    expect(notes.some((n: string) => n.includes('데이터셋'))).toBe(true);
  });

  it('사라진 종목만 제외하고 알린다', () => {
    const { state, notes } = requestToFormState(request, {
      ...catalog,
      datasets: [{ id: 'ds_1', symbols: ['005930'] }],
    });
    expect(state.symbols).toEqual(['005930']);
    expect(notes.some((n: string) => n.includes('000660'))).toBe(true);
  });

  it('전략이 사라지면 전략과 파라미터를 비우고 알린다', () => {
    const { state, notes } = requestToFormState(request, { ...catalog, strategyIds: [] });
    expect(state.strategyId).toBeNull();
    expect(state.parameters).toEqual({});
    expect(notes.some((n: string) => n.includes('range-breakout'))).toBe(true);
  });
});
