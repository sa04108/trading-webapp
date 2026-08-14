import { describe, expect, it } from 'vitest';
import { formatUniverseRuleSummary } from '../../src/web/features/backtests/universe-summary.js';
import type { UniverseRule } from '../../src/shared/schemas/universe-rule.js';

describe('formatUniverseRuleSummary', () => {
  it.each([
    ['HIGH', 'ROE 높음 40'],
    ['LOW', 'ROE 낮음 40'],
  ] as const)('ROE %s 방향을 요약한다', (direction, expectedStage) => {
    const rule: UniverseRule = {
      markets: ['KOSPI'],
      stages: [{ criterion: 'ROE', direction, limit: 40 }],
      rebalanceInterval: { unit: 'MONTH', value: 1 },
    };
    expect(formatUniverseRuleSummary(rule)).toBe(`KOSPI · ${expectedStage} · 매월`);
  });

  it('시장 · 단계(→로 연결) · 주기 순서로 한 줄 요약을 만든다', () => {
    const rule: UniverseRule = {
      markets: ['KOSPI'],
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 200 },
        { criterion: 'PER', direction: 'LOW', limit: 80 },
        { criterion: 'DECLINE', direction: 'LOW', limit: 40, lookbackTradingDays: 20 },
      ],
      rebalanceInterval: { unit: 'MONTH', value: 1 },
    };
    expect(formatUniverseRuleSummary(rule)).toBe(
      'KOSPI · 시가총액 상위 200 → PER 낮음 80 → 가격 변동 급하락(20일) 40 · 매월',
    );
  });

  it('방향 없는 기존 규칙은 과거 고정 방향으로 표시한다', () => {
    const legacy = {
      markets: ['KOSPI'],
      stages: [
        { criterion: 'MARKET_CAP', limit: 100 },
        { criterion: 'DECLINE', limit: 20, lookbackTradingDays: 20 },
      ],
      rebalanceInterval: { unit: 'MONTH', value: 1 },
    } as unknown as UniverseRule;
    expect(formatUniverseRuleSummary(legacy)).toBe(
      'KOSPI · 시가총액 상위 100 → 가격 변동 급하락(20일) 20 · 매월',
    );
  });

  it('단계가 하나뿐이면 화살표 없이 그 단계만 적는다', () => {
    const rule: UniverseRule = {
      markets: ['KOSDAQ'],
      stages: [{ criterion: 'VOLUME', direction: 'HIGH', limit: 100 }],
      rebalanceInterval: { unit: 'WEEK', value: 2 },
    };
    expect(formatUniverseRuleSummary(rule)).toBe('KOSDAQ · 거래량 상위 100 · 2주마다');
  });

  it('주기 value 가 1이면 매일/매주/매월/매년으로 적는다', () => {
    const base: UniverseRule = {
      markets: ['KOSPI'],
      stages: [{ criterion: 'TRADING_VALUE', direction: 'HIGH', limit: 50 }],
      rebalanceInterval: { unit: 'DAY', value: 1 },
    };
    expect(formatUniverseRuleSummary(base)).toBe('KOSPI · 거래대금 상위 50 · 매일');
    expect(
      formatUniverseRuleSummary({ ...base, rebalanceInterval: { unit: 'WEEK', value: 1 } }),
    ).toBe('KOSPI · 거래대금 상위 50 · 매주');
    expect(
      formatUniverseRuleSummary({ ...base, rebalanceInterval: { unit: 'MONTH', value: 1 } }),
    ).toBe('KOSPI · 거래대금 상위 50 · 매월');
    expect(
      formatUniverseRuleSummary({ ...base, rebalanceInterval: { unit: 'YEAR', value: 1 } }),
    ).toBe('KOSPI · 거래대금 상위 50 · 매년');
  });

  it('주기 value 가 1이 아니면 N일마다/N주마다/N개월마다로 적는다', () => {
    const base: UniverseRule = {
      markets: ['KOSPI'],
      stages: [{ criterion: 'TRADING_VALUE', direction: 'HIGH', limit: 50 }],
      rebalanceInterval: { unit: 'DAY', value: 1 },
    };
    expect(
      formatUniverseRuleSummary({ ...base, rebalanceInterval: { unit: 'DAY', value: 3 } }),
    ).toBe('KOSPI · 거래대금 상위 50 · 3일마다');
    expect(
      formatUniverseRuleSummary({ ...base, rebalanceInterval: { unit: 'WEEK', value: 2 } }),
    ).toBe('KOSPI · 거래대금 상위 50 · 2주마다');
    expect(
      formatUniverseRuleSummary({ ...base, rebalanceInterval: { unit: 'MONTH', value: 3 } }),
    ).toBe('KOSPI · 거래대금 상위 50 · 3개월마다');
  });
});
