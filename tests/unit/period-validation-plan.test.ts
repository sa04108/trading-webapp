import { describe, expect, it } from 'vitest';
import { buildPeriodValidationPlan, evaluateValidationCandidate, periodValidationConfigSchema, selectValidationCandidate, validationMonthOffset } from '../../src/shared/schemas/period-validation.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { intradayRequestSchema } from '../../src/shared/schemas/intraday.js';

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
    const config = { mode: 'HOLDOUT' as const, splitDate: '2023-01-01', optimization };
    const optimized = buildPeriodValidationPlan(source, periodValidationConfigSchema.parse(config));
    expect(optimized.folds).toEqual(plan.folds);
    expect(optimized.candidates).toEqual([{ lookbackDays: 10 }, { lookbackDays: 20 }]);
    expect(optimized.totalRuns).toBe(4);
    expect(periodValidationConfigSchema.parse({ ...config, mode: 'OPTIMIZED_HOLDOUT' })).toEqual(config);
    expect(periodValidationConfigSchema.safeParse({ mode: 'OPTIMIZED_HOLDOUT', splitDate: config.splitDate }).success).toBe(false);
  });
  it('워크포워드 OOS는 겹치지 않으며 마지막 불완전 구간을 명시한다', () => {
    const plan = buildPeriodValidationPlan(source, { mode: 'WALK_FORWARD', trainMonths: 36, testMonths: 6, optimization });
    expect(plan.folds).toEqual([
      { ordinal: 0, train: { from: '2020-01-01', to: '2022-12-31' }, test: { from: '2023-01-01', to: '2023-06-30' } },
      { ordinal: 1, train: { from: '2020-07-01', to: '2023-06-30' }, test: { from: '2023-07-01', to: '2023-12-31' } },
    ]);
    expect(plan.totalRuns).toBe(8);
    expect(plan.unusedPeriod).toEqual({ from: '2024-01-01', to: '2024-04-15' });
    const fixedConfig = periodValidationConfigSchema.parse({ mode: 'WALK_FORWARD', trainMonths: 36, testMonths: 6 });
    const fixed = buildPeriodValidationPlan(source, fixedConfig);
    expect(fixed.folds).toEqual(plan.folds);
    expect(fixed.unusedPeriod).toEqual(plan.unusedPeriod);
    expect(fixed.candidates).toEqual([source.parameters]);
    expect(fixed.totalRuns).toBe(4);
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
    expect(() => buildPeriodValidationPlan(source, { mode: 'HOLDOUT', splitDate: '2023-01-01', optimization: { ...optimization, axes: [{ key: 'lookbackDays', values: [10, 10] }] } })).toThrow('중복');
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
  it('선택 진단은 경계값을 통과시키고 사용할 수 없는 값과 조건 미달을 구분한다', () => {
    expect(evaluateValidationCandidate(metrics(-1, 5, -30), optimization)).toEqual({ eligible: true, reasons: [] });
    expect(evaluateValidationCandidate(metrics(null, 4, -31), optimization)).toEqual({ eligible: false, reasons: ['OBJECTIVE_UNAVAILABLE', 'INSUFFICIENT_TRADES', 'DRAWDOWN_LIMIT_EXCEEDED'] });
    expect(evaluateValidationCandidate(metrics(1, Number.NaN, Number.NaN), optimization)).toEqual({ eligible: false, reasons: ['TRADE_COUNT_UNAVAILABLE', 'DRAWDOWN_UNAVAILABLE'] });
    expect(selectValidationCandidate([{ candidate: 0, metrics: metrics(-1, 5, -30) }], optimization)).toBe(0);
  });
  it('음수 점수도 비교하며 동률은 완료 순서와 무관하게 결정한다', () => {
    expect(selectValidationCandidate([{ candidate: 2, metrics: metrics(-1) }, { candidate: 1, metrics: metrics(-1) }, { candidate: 0, metrics: metrics(-2) }], optimization)).toBe(1);
  });
  it('유효한 후보가 없으면 원본으로 임의 대체하지 않는다', () => {
    expect(selectValidationCandidate([{ candidate: 0, metrics: metrics(Number.NaN) }, { candidate: 1, metrics: metrics(1, 0) }], optimization)).toBeNull();
  });
});

// 일봉 계획만 검사하면 분봉 요청이 일봉 스키마로 검증되거나 교차 필드 조건을 건너뛰는 회귀를 놓친다.
describe('분봉 검증 계획의 요청 경계', () => {
  const intraday = intradayRequestSchema.parse({ mode: 'intraday', strategyId: 'intraday-ema', symbol: '005930',
    period: { from: '2026-01-05', to: '2026-10-30' }, timeframe: '15m', initialCash: 10_000_000,
    parameters: { fast: 3, slow: 5, allocationPct: 95, stopLossPct: 1.5, takeProfitPct: 3 },
    execution: { holdingPolicy: 'DAY_ONLY', commissionBps: 1.5, taxBps: 20, slippageBps: 5, latencyMs: 1000, orderExpiryMinutes: 3, maxParticipationPct: 1 } });
  it('분봉 원본을 검증하고 후보마다 EMA 관계와 일중 준비 시간을 적용한다', () => {
    expect(buildPeriodValidationPlan(intraday, { mode: 'HOLDOUT', splitDate: '2026-07-01' }).totalRuns).toBe(2);
    for (const axes of [{ key: 'fast', values: [2, 6] }, { key: 'slow', values: [80, 100] }]) {
      expect(() => buildPeriodValidationPlan(intraday, { mode: 'HOLDOUT', splitDate: '2026-07-01', optimization: { ...optimization, axes: [axes] } })).toThrow();
    }
  });
  it('정의되지 않은 CAGR과 전략 밖의 매개변수 탐색을 거부한다', () => {
    const config = { mode: 'HOLDOUT' as const, splitDate: '2026-07-01', optimization: { ...optimization, axes: [{ key: 'fast', values: [2, 3] }] } };
    expect(() => buildPeriodValidationPlan(intraday, { ...config, optimization: { ...config.optimization, objective: 'cagrPct' } })).toThrow('Sharpe');
    expect(() => buildPeriodValidationPlan(intraday, { ...config, optimization: { ...config.optimization, axes: [{ key: 'initialCash', values: [10000, 20000] }] } })).toThrow('매개변수');
  });
});
