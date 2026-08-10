import { describe, expect, it } from 'vitest';
import { isNonTradingRow } from '../../src/server/modules/market-data/domain/non-trading-day.js';
import type { KrxDailyTradeRow } from '../../src/server/modules/market-data/domain/krx-universe-types.js';

function row(partial: Partial<KrxDailyTradeRow>): KrxDailyTradeRow {
  return {
    shortCode: '000000',
    name: '테스트',
    marketCapRaw: '1000',
    tradingValueRaw: null,
    open: 1_000,
    high: 1_100,
    low: 900,
    close: 1_050,
    volume: 10_000,
    ...partial,
  };
}

describe('isNonTradingRow', () => {
  // 실측(2026-08-08, docs/superpowers/specs/2026-08-08-delisting-and-non-trading-days-design.md
  // "KRX 실응답 실측"): 정지 종목은 시·고·저가 0, 종가는 직전가, 거래량 0으로 온다
  it('신라젠 2021-06-15 정지 행을 거래불가로 본다', () => {
    expect(isNonTradingRow(row({ open: 0, high: 0, low: 0, close: 12_100, volume: 0 }))).toBe(true);
  });

  it('성안 저유동성 무거래 행도 같은 모양이라 거래불가로 본다', () => {
    expect(isNonTradingRow(row({ open: 0, high: 0, low: 0, close: 787, volume: 0 }))).toBe(true);
  });

  it('오스템임플란트 2021-06-15 정상 거래 행은 아니다', () => {
    expect(
      isNonTradingRow(row({ open: 98_000, high: 99_500, low: 97_400, close: 99_400, volume: 113_801 })),
    ).toBe(false);
  });

  // 아래 셋은 "거래불가가 아닌 이상 행" 이다 — invalidCount 로 남아야 파싱 버그를 찾을 수 있다
  it('종가까지 0이면 거래불가가 아니다', () => {
    expect(isNonTradingRow(row({ open: 0, high: 0, low: 0, close: 0, volume: 0 }))).toBe(false);
  });

  it('시·고·저가 0인데 거래량이 있으면 거래불가가 아니다', () => {
    expect(isNonTradingRow(row({ open: 0, high: 0, low: 0, close: 900, volume: 500 }))).toBe(false);
  });

  it('null 이 섞인 행은 거래불가가 아니다', () => {
    expect(isNonTradingRow(row({ open: null, high: 0, low: 0, close: 900, volume: 0 }))).toBe(false);
  });

  it('high < low 같은 파싱 버그 행은 거래불가가 아니다', () => {
    expect(isNonTradingRow(row({ open: 1_000, high: 900, low: 1_100, close: 1_000, volume: 5 }))).toBe(false);
  });
});
