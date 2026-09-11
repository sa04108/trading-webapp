import { describe, expect, it } from 'vitest';
import { buildPeriodValidationPlan, periodValidationConfigSchema, selectValidationCandidate, validationMonthOffset } from '../../src/shared/schemas/period-validation.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';

const source: BacktestRequest = {
  strategyId: 'range-breakout', parameters: { lookbackDays: 20 },
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 10 }], rebalanceInterval: { unit: 'MONTH', value: 1 } },
  period: { from: '2020-01-01', to: '2024-04-15' },
  capital: { initialCash: 10_000_000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'kr-equity-default', slippageProfileId: 'fixed-5bps' },
  risk: { maxPositions: 5 }, randomSeed: 42,
};
const optimization = { axes: [{ key: 'lookbackDays', values: [10, 20] }], objective: 'sharpe' as const, minTrades: 5, maxDrawdownPct: 30 };

describe('독립 구간 검증 계획', () => {
  it('분할일은 OOS에만 포함하고 홀드아웃은 두 번 실행한다', () => {
    const plan = buildPeriodValidationPlan(source, { mode: 'HOLDOUT', splitDate: '2023-01-01' });
    expect(plan.folds).toEqual([{ ordinal: 0, train: { from: '2020-01-01', to: '2022-12-31' }, test: { from: '2023-01-01', to: '2024-04-15' } }]);
    expect(plan.totalRuns).toBe(2);
  });
  it('워크포워드 OOS는 겹치지 않으며 마지막 불완전 구간을 명시한다', () => {
    const plan = buildPeriodValidationPlan(source, { mode: 'WALK_FORWARD', trainMonths: 36, testMonths: 6, optimization });
    expect(plan.folds).toEqual([
      { ordinal: 0, train: { from: '2020-01-01', to: '2022-12-31' }, test: { from: '2023-01-01', to: '2023-06-30' } },
      { ordinal: 1, train: { from: '2020-07-01', to: '2023-06-30' }, test: { from: '2023-07-01', to: '2023-12-31' } },
    ]);
    expect(plan.totalRuns).toBe(8);
    expect(plan.unusedPeriod).toEqual({ from: '2024-01-01', to: '2024-04-15' });
  });
  it('윤년과 월말에도 기준 날짜에서 이동한다', () => {
    expect(validationMonthOffset('2024-01-31', 1)).toBe('2024-02-29');
    expect(validationMonthOffset('2024-01-31', 2)).toBe('2024-03-31');
    const plan = buildPeriodValidationPlan({ ...source, period: { from: '2024-01-31', to: '2024-07-30' }, universeRule: { ...source.universeRule, rebalanceInterval: { unit: 'DAY', value: 1 } } }, { mode: 'WALK_FORWARD', trainMonths: 2, testMonths: 1, optimization });
    expect(plan.folds.map((fold) => fold.test)).toEqual([
      { from: '2024-03-31', to: '2024-04-29' }, { from: '2024-04-30', to: '2024-05-30' },
      { from: '2024-05-31', to: '2024-06-29' }, { from: '2024-06-30', to: '2024-07-30' },
    ]);
  });
  it('너무 짧은 구간과 불가능한 리밸런싱 주기를 거부한다', () => {
    expect(() => buildPeriodValidationPlan(source, { mode: 'HOLDOUT', splitDate: source.period.from })).toThrow();
    expect(() => buildPeriodValidationPlan(source, { mode: 'HOLDOUT', splitDate: source.period.to })).toThrow('최소 2일');
    expect(() => buildPeriodValidationPlan(source, { mode: 'HOLDOUT', splitDate: '2020-01-03' })).toThrow('리밸런싱');
    expect(periodValidationConfigSchema.safeParse({ mode: 'HOLDOUT', splitDate: '2024-02-30' }).success).toBe(false);
  });
  it('중복 후보와 실행 폭증을 미리 차단한다', () => {
    expect(() => buildPeriodValidationPlan(source, { mode: 'OPTIMIZED_HOLDOUT', splitDate: '2023-01-01', optimization: { ...optimization, axes: [{ key: 'lookbackDays', values: [10, 10] }] } })).toThrow('중복');
    expect(() => buildPeriodValidationPlan(source, { mode: 'WALK_FORWARD', trainMonths: 1, testMonths: 1, optimization: { ...optimization, axes: [{ key: 'lookbackDays', values: Array.from({ length: 20 }, (_, i) => i + 1) }] } })).toThrow('상한');
  });
});

describe('IS 후보 선택', () => {
  const metrics = (sharpe: number | null, tradeCount = 10, maxDrawdownPct = -10) => ({ totalReturnPct: 5, cagrPct: 5, sharpe, tradeCount, maxDrawdownPct });
  it('거래 수·낙폭 조건을 적용하고 계산 불가 지표를 제외한다', () => {
    expect(selectValidationCandidate([
      { candidate: 0, metrics: metrics(10, 1) }, { candidate: 1, metrics: metrics(5, 20, -40) },
      { candidate: 2, metrics: metrics(null) }, { candidate: 3, metrics: metrics(0.5) },
    ], optimization)).toBe(3);
  });
  it('음수 점수도 비교하며 동률은 완료 순서와 무관하게 결정한다', () => {
    expect(selectValidationCandidate([{ candidate: 2, metrics: metrics(-1) }, { candidate: 1, metrics: metrics(-1) }, { candidate: 0, metrics: metrics(-2) }], optimization)).toBe(1);
  });
  it('유효한 후보가 없으면 원본으로 임의 대체하지 않는다', () => {
    expect(selectValidationCandidate([{ candidate: 0, metrics: metrics(Number.NaN) }, { candidate: 1, metrics: metrics(1, 0) }], optimization)).toBeNull();
  });
});
