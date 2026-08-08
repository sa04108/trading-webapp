import { describe, expect, it } from 'vitest';
import { adjustForRatio } from '../../src/server/modules/backtest/domain/corporate-action-adjust.js';

describe('adjustForRatio', () => {
  it('5:1 분할은 수량을 5배로 늘리고 단가를 5분의 1로 줄인다', () => {
    const result = adjustForRatio(10, 100_000, 5, 20_000);
    expect(result.quantity).toBe(50);
    expect(result.avgEntryPrice).toBe(20_000);
    expect(result.cashFromFraction).toBe(0);
    expect(result.closed).toBe(false);
  });

  it('수량 × 단가를 보존한다', () => {
    const before = 7 * 30_000;
    const result = adjustForRatio(7, 30_000, 3, 10_000);
    expect(result.quantity * result.avgEntryPrice).toBe(before);
  });

  it('역분할 잔여를 현금으로 환산한다', () => {
    // 1:5 역병합(ratio 0.2) — 3주가 0.6주가 된다. 내림해 0주, 잔여 0.6주.
    const result = adjustForRatio(3, 10_000, 0.2, 50_000);
    expect(result.quantity).toBe(0);
    expect(result.cashFromFraction).toBeCloseTo(0.6 * 50_000, 6);
    expect(result.closed).toBe(true);
  });

  it('역분할에서 정수 몫이 남으면 포지션을 닫지 않는다', () => {
    // 12주 × 0.2 = 2.4주 → 2주 + 잔여 0.4주
    const result = adjustForRatio(12, 10_000, 0.2, 50_000);
    expect(result.quantity).toBe(2);
    expect(result.cashFromFraction).toBeCloseTo(0.4 * 50_000, 6);
    expect(result.closed).toBe(false);
  });

  it('단가는 잔여를 덜어내기 전 비율로 나눈다', () => {
    // 자산 보존: 조정 후 평가액 + 잔여 현금 = 조정 전 평가액
    const result = adjustForRatio(12, 10_000, 0.2, 50_000);
    expect(result.avgEntryPrice).toBe(50_000);
    expect(result.quantity * result.avgEntryPrice + result.cashFromFraction).toBeCloseTo(12 * 10_000, 6);
  });

  it('ratio 가 1 이면 아무것도 바꾸지 않는다', () => {
    const result = adjustForRatio(10, 100_000, 1, 100_000);
    expect(result).toEqual({
      quantity: 10,
      avgEntryPrice: 100_000,
      cashFromFraction: 0,
      closed: false,
    });
  });
});
