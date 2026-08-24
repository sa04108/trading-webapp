import { describe, expect, it } from 'vitest';
import {
  getCostProfile,
  getKrxExecutionRules,
  getSlippageProfile,
  sellTaxAmount,
  sellTaxRateAt,
  tickSizeAt,
} from '../../src/server/modules/backtest/domain/cost-profiles.js';

describe('kr-equity-default', () => {
  it.each([
    ['2019-05-29', 0.003],
    ['2019-05-30', 0.0025],
    ['2020-12-29', 0.0023],
    ['2022-12-28', 0.002],
    ['2023-12-27', 0.0018],
    ['2024-12-27', 0.0015],
    ['2025-12-29', 0.002],
  ])('%s 체결일의 매도세율을 적용한다', (date, expected) => {
    const profile = getCostProfile('kr-equity-default')!;
    expect(sellTaxRateAt(profile, Date.parse(`${date}T00:00:00Z`))).toBe(expected);
  });

  it('수수료율은 매수·매도 0.015% 그대로다', () => {
    const profile = getCostProfile('kr-equity-default');
    expect(profile?.buyCommissionRate).toBe(0.00015);
    expect(profile?.sellCommissionRate).toBe(0.00015);
  });

  it('KOSPI는 증권거래세와 농특세를 각각 원 미만 절사한다', () => {
    const profile = getCostProfile('kr-equity-default')!;
    const at = Date.parse('2026-01-02T00:00:00Z');
    expect(sellTaxAmount(profile, 1_999, at, 'KOSPI')).toBe(2);
    expect(sellTaxAmount(profile, 1_999, at, 'KOSDAQ')).toBe(3);
  });
});

describe('KRX 보통주 호가단위', () => {
  it('실전 체결 규칙은 직전 거래 봉 거래량의 10%로 체결을 제한한다', () => {
    expect(getKrxExecutionRules('KOSPI').maxVolumeParticipationRate).toBe(0.1);
  });

  it.each([
    [1_999, 1],
    [2_000, 5],
    [5_000, 10],
    [20_000, 50],
    [50_000, 100],
    [200_000, 500],
    [500_000, 1_000],
  ])('2023-01-25부터 %,d원 가격의 호가단위는 %,d원이다', (price, expected) => {
    expect(tickSizeAt(
      getKrxExecutionRules('KOSPI'),
      price,
      Date.parse('2023-01-25T00:00:00Z'),
    )).toBe(expected);
  });

  it('2023-01-25 전 고가 구간은 KOSPI와 KOSDAQ 규칙을 구분한다', () => {
    const before = Date.parse('2023-01-24T00:00:00Z');
    expect(tickSizeAt(getKrxExecutionRules('KOSPI'), 150_000, before)).toBe(500);
    expect(tickSizeAt(getKrxExecutionRules('KOSDAQ'), 150_000, before)).toBe(100);
    expect(tickSizeAt(getKrxExecutionRules('KOSPI'), 600_000, before)).toBe(1_000);
    expect(tickSizeAt(getKrxExecutionRules('KOSDAQ'), 600_000, before)).toBe(100);
  });
});

describe('fixed-5bps', () => {
  it('5bp 고정 슬리피지다', () => {
    const profile = getSlippageProfile('fixed-5bps');
    expect(profile?.bps).toBe(5);
    expect(profile?.fixed).toBe(0);
  });
});
