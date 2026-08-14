import { describe, expect, it } from 'vitest';
import {
  backtestRequestSchema,
  periodToTsRange,
} from '../../src/shared/schemas/backtest-request.js';

describe('periodToTsRange', () => {
  it('구간은 to 일자의 끝까지 포함한다 (UTC)', () => {
    const { fromTsMs, toTsMs } = periodToTsRange({ from: '2025-07-27', to: '2026-07-24' });
    expect(fromTsMs).toBe(Date.UTC(2025, 6, 27, 0, 0, 0, 0));
    expect(toTsMs).toBe(Date.UTC(2026, 6, 24, 23, 59, 59, 999));
  });

});

/** universeRule 없이는 성립하지 않는 나머지 필드들 — 각 테스트가 필요한 만큼만 덮어쓴다 */
function baseRequest(): Record<string, unknown> {
  return {
    strategyId: 'range-breakout',
    parameters: {},
    universeRule: {
      markets: ['KOSPI'],
      stages: [{ criterion: 'MARKET_CAP', limit: 50 }],
      rebalanceInterval: { value: 1, unit: 'MONTH' },
    },
    period: { from: '2020-01-01', to: '2025-12-31' },
    capital: { initialCash: 10_000_000, currency: 'KRW' },
    execution: {
      fillTiming: 'NEXT_BAR_OPEN',
      commissionProfileId: 'kr-default',
      slippageProfileId: 'kr-default',
    },
    risk: { maxPositions: 20 },
  };
}

/**
 * 단계형 유니버스 규칙은 1~5개의 기준을 순서대로 적용한다. 이후 단계는 앞 단계가
 * 남긴 후보 수를 늘릴 수 없고 같은 기준을 반복할 수 없다.
 */
describe('universeRule', () => {
  const validRule = {
    markets: ['KOSPI'] as const,
    stages: [
      { criterion: 'MARKET_CAP' as const, limit: 100 },
      { criterion: 'PER' as const, limit: 40 },
    ],
    rebalanceInterval: { value: 1, unit: 'MONTH' as const },
  };

  it('universeRule 이 없으면 거부한다', () => {
    const { universeRule: _drop, ...rest } = baseRequest();
    expect(backtestRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('markets 가 2개면 거부한다 — 워커가 단일 시장만 다룬다', () => {
    const result = backtestRequestSchema.safeParse({
      ...baseRequest(),
      universeRule: { ...validRule, markets: ['KOSPI', 'KOSDAQ'] },
    });
    expect(result.success).toBe(false);
  });

  it('markets 가 0개면 거부한다', () => {
    const result = backtestRequestSchema.safeParse({
      ...baseRequest(),
      universeRule: { ...validRule, markets: [] },
    });
    expect(result.success).toBe(false);
  });

  it('정상 단계형 유니버스 규칙은 그대로 파싱된다', () => {
    const result = backtestRequestSchema.safeParse({ ...baseRequest(), universeRule: validRule });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.universeRule).toEqual(validRule);
    }
  });

  it('DECLINE 단계는 1~252 거래일 lookback을 명시해야 한다', () => {
    const withLookback = {
      ...validRule,
      stages: [{ criterion: 'DECLINE', limit: 40, lookbackTradingDays: 20 }],
    };
    const parsed = backtestRequestSchema.safeParse({ ...baseRequest(), universeRule: withLookback });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.universeRule).toEqual(withLookback);

    for (const lookbackTradingDays of [undefined, 0, 253]) {
      expect(backtestRequestSchema.safeParse({
        ...baseRequest(),
        universeRule: {
          ...validRule,
          stages: [{ criterion: 'DECLINE', limit: 40, lookbackTradingDays }],
        },
      }).success).toBe(false);
    }
  });

  it('DECLINE 이외 단계는 lookbackTradingDays를 보존하지 않는다', () => {
    const parsed = backtestRequestSchema.safeParse({
      ...baseRequest(),
      universeRule: {
        ...validRule,
        stages: [{ criterion: 'MARKET_CAP', limit: 40, lookbackTradingDays: 20 }],
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.universeRule.stages).toEqual([{ criterion: 'MARKET_CAP', limit: 40 }]);
    }
  });

  it.each([
    ['중복 기준', { ...validRule, stages: [{ criterion: 'PER', limit: 100 }, { criterion: 'PER', limit: 40 }] }],
    ['증가하는 N', { ...validRule, stages: [{ criterion: 'MARKET_CAP', limit: 40 }, { criterion: 'PER', limit: 41 }] }],
    ['6개 단계', { ...validRule, stages: Array.from({ length: 6 }, (_, i) => ({ criterion: ['MARKET_CAP', 'VOLUME', 'TRADING_VALUE', 'PER', 'DECLINE'][i % 5], limit: 10 })) }],
  ])('%s 규칙을 거부한다', (_name, universeRule) => {
    expect(backtestRequestSchema.safeParse({ ...baseRequest(), universeRule }).success).toBe(false);
  });

});

describe('요청 교차 검증', () => {
  it('risk를 생략한 신규 요청에는 maxPositions 40을 채운다', () => {
    const { risk: _risk, ...requestWithoutRisk } = baseRequest();
    const parsed = backtestRequestSchema.safeParse(requestWithoutRisk);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.risk.maxPositions).toBe(40);
  });

  it('maxPositions 40을 허용한다', () => {
    expect(backtestRequestSchema.safeParse({ ...baseRequest(), risk: { maxPositions: 40 } }).success).toBe(true);
  });

  it('리밸런싱 주기가 기간을 넘으면 거부한다', () => {
    expect(backtestRequestSchema.safeParse({
      ...baseRequest(),
      period: { from: '2025-01-01', to: '2025-01-31' },
      universeRule: {
        markets: ['KOSPI'],
        stages: [{ criterion: 'MARKET_CAP', limit: 50 }],
        rebalanceInterval: { value: 2, unit: 'MONTH' },
      },
    }).success).toBe(false);
  });

  it('존재하지 않는 날짜(2026-13-45)는 형식 검사를 통과해도 거부한다', () => {
    // 정규식만으로는 자릿수만 보고 통과시킨다 — 그러면 리밸런스 날짜 계산이
    // 나중에 RangeError 를 던져 500 이 된다(리뷰 finding, 2026-08-09).
    const result = backtestRequestSchema.safeParse({
      ...baseRequest(),
      period: { from: '2026-13-45', to: '2026-12-31' },
    });
    expect(result.success).toBe(false);
  });

  it('굴러 넘어가는 날짜(2026-02-30)도 거부한다 — Date 생성자가 조용히 다음 달로 굴린다', () => {
    const result = backtestRequestSchema.safeParse({
      ...baseRequest(),
      period: { from: '2026-02-30', to: '2026-12-31' },
    });
    expect(result.success).toBe(false);
  });

  it('전략 topN이 동시 보유 상한 또는 마지막 단계 N을 넘으면 거부한다', () => {
    const request = {
      ...baseRequest(),
      parameters: { topN: 41 },
      universeRule: {
        markets: ['KOSPI'],
        stages: [{ criterion: 'MARKET_CAP', limit: 40 }],
        rebalanceInterval: { value: 1, unit: 'MONTH' },
      },
      risk: { maxPositions: 40 },
    };
    expect(backtestRequestSchema.safeParse(request).success).toBe(false);
  });
});
