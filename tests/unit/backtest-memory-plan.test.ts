import { describe, expect, it } from 'vitest';
import { backtestBatchBars, backtestMemoryPlan } from '../../src/runtime/modules/backtest/application/backtest-memory-plan.js';

const MIB = 1024 ** 2;
function payload(symbolCount = 377, strategyId = 'ema-trend-switch') {
  return {
    requestJson: JSON.stringify({
      universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 200 }], rebalanceInterval: { unit: 'MONTH', value: 1 } },
      period: { from: '2016-08-01', to: '2026-09-12' }, strategyId, parameters: {},
      capital: { initialCash: 100_000_000, currency: 'KRW' },
      execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'zero-cost', slippageProfileId: 'zero-slippage' },
      risk: { maxPositions: 10 }, randomSeed: 42,
    }),
    universeScheduleJson: JSON.stringify([{ symbols: Array.from({ length: symbolCount }, (_, i) => String(i).padStart(6, '0')) }]),
    estimatedBars: 812_212,
  };
}

describe('로컬 백테스트 상주 메모리 계획', () => {
  it('원시 봉 총량은 입력 배열처럼 계산하지 않고 기간·종목·전략 이력을 반영한다', () => {
    const input = payload();
    const plan = backtestMemoryPlan(input, () => 0);
    expect(plan.requiredBytes).toBeLessThan(245.65625 * MIB);
    expect(plan.minimumBatchBars).toBe(377);
    expect(backtestMemoryPlan({ ...input, estimatedBars: 2_000_000 }, () => 0)).toEqual(plan);
    expect(backtestMemoryPlan(payload(2000), () => 0).requiredBytes).toBeGreaterThan(plan.requiredBytes);
    expect(backtestMemoryPlan(payload(377, 'cross-sectional-momentum'), () => 0).requiredBytes).toBeGreaterThan(plan.requiredBytes);
  });

  it('시작 필요량 경계에서는 하루 전체 종목을 읽고 여유에 따라 묶음을 늘린다', () => {
    const plan = backtestMemoryPlan(payload(), () => 0);
    expect(backtestBatchBars(plan.requiredBytes, plan)).toBe(plan.minimumBatchBars);
    expect(backtestBatchBars(plan.requiredBytes + MIB, plan)).toBe(plan.minimumBatchBars + 1024);
    expect(backtestBatchBars(245.65625 * MIB, plan)).toBe(8192);
    expect(backtestBatchBars(256 * MIB, plan)).toBe(8192);
    expect(backtestBatchBars(300 * MIB, { requiredBytes: 256 * MIB, minimumBatchBars: 10_000 })).toBe(10_000);
  });

  it('잘못된 입력은 무한 자원 대기 대신 워커에서 입력 오류로 확인한다', () => {
    const plan = backtestMemoryPlan({ requestJson: '{' });
    expect(Number.isSafeInteger(plan.requiredBytes)).toBe(true);
    expect(plan.requiredBytes).toBeGreaterThanOrEqual(128 * MIB);
    expect(plan.requiredBytes).toBeLessThan(256 * MIB);
  });

  it('가격 전략에서도 실제 게시 팩트 수를 반영하고 집계 실패를 작은 작업으로 바꾸지 않는다', () => {
    const input = payload();
    const empty = backtestMemoryPlan(input, () => 0);
    const populated = backtestMemoryPlan(input, (symbols, throughTsMs) => {
      expect(symbols).toHaveLength(377);
      expect(throughTsMs).toBe(Date.parse('2026-09-13') - 1);
      return 100_000;
    });
    expect(populated.requiredBytes - empty.requiredBytes).toBeGreaterThanOrEqual(48 * MIB);
    expect(() => backtestMemoryPlan(input, () => { throw new Error('snapshot unreadable'); }))
      .toThrow('게시 스냅샷의 입력 메모리를 확인하지 못했습니다');
  });
});
