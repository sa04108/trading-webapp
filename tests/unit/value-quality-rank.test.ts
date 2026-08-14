import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import { createRng } from '../../src/server/modules/backtest/domain/seeded-rng.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type {
  Fact,
  FundamentalField,
  FundamentalSnapshot,
} from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import type { StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import {
  computeValueQualityMetrics,
  currentQuarterOrdinal,
  valueQualityRankParameters,
  valueQualityRankStrategy,
} from '../../src/server/modules/strategy/strategies/value-quality-rank.js';

/**
 * 계정 → 값 맵으로 스냅샷을 흉내낸다. ttm 은 손익 계정만 응답한다.
 *
 * periodKeyOf 는 기본적으로 latestPeriodKey(전사 최댓값)를 그대로 돌려주지만,
 * `fieldPeriods` 로 계정별 분기를 따로 지정할 수 있다 — 손익계산서는 최신인데
 * 재무상태표 계정만 낡은 시나리오를 만들기 위해서다. 값이 없는 계정은(=values 에
 * 키가 없으면) null 을 준다 — 실제 PitFactView 의 get/periodKeyOf 계약과 같다.
 */
function snapshot(
  values: Partial<Record<FundamentalField, number>>,
  options: {
    latestPeriodKey?: string;
    ttmOperatingIncome?: number | null;
    fieldPeriods?: Partial<Record<FundamentalField, string>>;
  } = {},
): FundamentalSnapshot {
  const latestPeriodKey = options.latestPeriodKey ?? '2025Q1';
  return {
    latestPeriodKey,
    latestAsOfTsMs: 0,
    get: (field) => values[field] ?? null,
    quarter: (field, offset = 0) => {
      const value = values[field];
      return offset === 0 && value !== undefined ? { periodKey: latestPeriodKey, value } : null;
    },
    ttm: (field) =>
      field === 'OPERATING_INCOME' ? (options.ttmOperatingIncome ?? null) : null,
    periodKeyOf: (field) => {
      if (field === 'OPERATING_INCOME') {
        if (options.ttmOperatingIncome === null || options.ttmOperatingIncome === undefined) {
          return null;
        }
        return options.fieldPeriods?.OPERATING_INCOME ?? latestPeriodKey;
      }
      if (values[field] === undefined) return null;
      return options.fieldPeriods?.[field] ?? latestPeriodKey;
    },
  };
}

const HEALTHY: Partial<Record<FundamentalField, number>> = {
  SHARES_OUTSTANDING: 1_000,
  CURRENT_ASSETS: 500_000,
  CURRENT_LIABILITIES: 200_000,
  TANGIBLE_ASSETS: 400_000,
  CASH_AND_EQUIVALENTS: 50_000,
  SHORT_TERM_INVESTMENTS: 30_000,
  SHORT_TERM_BORROWINGS: 60_000,
  CURRENT_LONG_TERM_DEBT: 10_000,
  BONDS: 20_000,
  LONG_TERM_BORROWINGS: 40_000,
};

/** 2025Q2(4~6월) 의 분기 서수 */
const Q2_2025 = 2025 * 4 + 1;

describe('currentQuarterOrdinal', () => {
  it('KST 월을 분기로 접는다', () => {
    expect(currentQuarterOrdinal(Date.UTC(2025, 0, 15))).toBe(2025 * 4); // 1월 → Q1
    expect(currentQuarterOrdinal(Date.UTC(2025, 4, 15))).toBe(2025 * 4 + 1); // 5월 → Q2
    expect(currentQuarterOrdinal(Date.UTC(2025, 11, 1))).toBe(2025 * 4 + 3); // 12월 → Q4
  });

  it('UTC 가 아니라 KST 로 접는다', () => {
    // 2025-04-01 00:00 KST = 2025-03-31 15:00 UTC → Q2
    expect(currentQuarterOrdinal(Date.UTC(2025, 2, 31, 15, 0))).toBe(2025 * 4 + 1);
  });
});

describe('computeValueQualityMetrics', () => {
  it('이익수익률과 자본수익률을 낸다', () => {
    const metrics = computeValueQualityMetrics(
      snapshot(HEALTHY, { ttmOperatingIncome: 120_000 }),
      1_000, // 종가 → 시가총액 1,000주 × 1,000 = 1,000,000
      Q2_2025,
      2,
    );
    // 총차입금 60,000+10,000+20,000+40,000 = 130,000
    // 현금성 50,000+30,000 = 80,000
    // EV = 1,000,000 + 130,000 - 80,000 = 1,050,000
    expect(metrics?.earningsYield).toBeCloseTo(120_000 / 1_050_000);
    // 순운전자본 500,000-200,000 = 300,000, +유형자산 400,000 = 700,000
    expect(metrics?.returnOnCapital).toBeCloseTo(120_000 / 700_000);
  });

  it('TTM 영업이익이 없으면 null', () => {
    expect(
      computeValueQualityMetrics(snapshot(HEALTHY, { ttmOperatingIncome: null }), 1_000, Q2_2025, 2),
    ).toBeNull();
  });

  it('TTM 영업이익이 0 이하면 null (Greenblatt 규칙)', () => {
    expect(
      computeValueQualityMetrics(snapshot(HEALTHY, { ttmOperatingIncome: 0 }), 1_000, Q2_2025, 2),
    ).toBeNull();
    expect(
      computeValueQualityMetrics(snapshot(HEALTHY, { ttmOperatingIncome: -1 }), 1_000, Q2_2025, 2),
    ).toBeNull();
  });

  it('발행주식수가 없으면 null — 시가총액을 만들 수 없다', () => {
    const { SHARES_OUTSTANDING: _omitted, ...withoutShares } = HEALTHY;
    expect(
      computeValueQualityMetrics(
        snapshot(withoutShares, { ttmOperatingIncome: 120_000 }),
        1_000,
        Q2_2025,
        2,
      ),
    ).toBeNull();
  });

  it('현금이 시가총액+차입금을 넘어 EV 가 0 이하면 null', () => {
    const cashRich = { ...HEALTHY, CASH_AND_EQUIVALENTS: 5_000_000 };
    expect(
      computeValueQualityMetrics(
        snapshot(cashRich, { ttmOperatingIncome: 120_000 }),
        1_000,
        Q2_2025,
        2,
      ),
    ).toBeNull();
  });

  it('순운전자본이 음수면 0 으로 깎는다 (원 규칙)', () => {
    const negativeWorkingCapital = { ...HEALTHY, CURRENT_ASSETS: 100_000 }; // 100,000-200,000 < 0
    const metrics = computeValueQualityMetrics(
      snapshot(negativeWorkingCapital, { ttmOperatingIncome: 120_000 }),
      1_000,
      Q2_2025,
      2,
    );
    // 투입자본 = 0 + 유형자산 400,000
    expect(metrics?.returnOnCapital).toBeCloseTo(120_000 / 400_000);
  });

  it('투입자본이 0 이면 null — 무한 수익률을 만들지 않는다', () => {
    const noCapital = { ...HEALTHY, CURRENT_ASSETS: 0, TANGIBLE_ASSETS: 0 };
    expect(
      computeValueQualityMetrics(
        snapshot(noCapital, { ttmOperatingIncome: 120_000 }),
        1_000,
        Q2_2025,
        2,
      ),
    ).toBeNull();
  });

  it('공시가 staleQuarters 보다 낡으면 null', () => {
    // 최신 공시가 2024Q2 (서수 2024*4+1) → 현재 2025Q2 와 4분기 차
    const stale = snapshot(HEALTHY, {
      ttmOperatingIncome: 120_000,
      latestPeriodKey: '2024Q2',
    });
    expect(computeValueQualityMetrics(stale, 1_000, Q2_2025, 2)).toBeNull();
    // staleQuarters 를 넉넉히 주면 통과한다
    expect(computeValueQualityMetrics(stale, 1_000, Q2_2025, 8)).not.toBeNull();
  });

  it('직전 분기 공시는 낡은 것이 아니다', () => {
    const fresh = snapshot(HEALTHY, {
      ttmOperatingIncome: 120_000,
      latestPeriodKey: '2025Q1',
    });
    expect(computeValueQualityMetrics(fresh, 1_000, Q2_2025, 2)).not.toBeNull();
  });

  it('분기 키가 아닌 latestPeriodKey 는 null', () => {
    const annual = snapshot(HEALTHY, {
      ttmOperatingIncome: 120_000,
      latestPeriodKey: '2025FY',
    });
    expect(computeValueQualityMetrics(annual, 1_000, Q2_2025, 2)).toBeNull();
  });

  it('유형자산 계정이 아예 공시되지 않으면 null — 0 인 것과는 다르다', () => {
    // '순운전자본이 음수면 0 으로 깎는다'·'투입자본이 0 이면 null' 테스트는 항상
    // 세 계정에 실수(0 포함)를 채워 넣는다 — get() 이 null 을 반환하는 경로는
    // SHARES_OUTSTANDING 을 지운 케이스 말고는 아무도 건드리지 않았다. 이 값이
    // '?? 0' 으로 완화돼도(부채·현금 계정처럼) 그 완화를 잡아낼 테스트가 없었다.
    const { TANGIBLE_ASSETS: _omittedTangible, ...withoutTangible } = HEALTHY;
    expect(
      computeValueQualityMetrics(
        snapshot(withoutTangible, { ttmOperatingIncome: 120_000 }),
        1_000,
        Q2_2025,
        2,
      ),
    ).toBeNull();

    const { CURRENT_ASSETS: _omittedCurrentAssets, ...withoutCurrentAssets } = HEALTHY;
    expect(
      computeValueQualityMetrics(
        snapshot(withoutCurrentAssets, { ttmOperatingIncome: 120_000 }),
        1_000,
        Q2_2025,
        2,
      ),
    ).toBeNull();

    const { CURRENT_LIABILITIES: _omittedCurrentLiabilities, ...withoutCurrentLiabilities } = HEALTHY;
    expect(
      computeValueQualityMetrics(
        snapshot(withoutCurrentLiabilities, { ttmOperatingIncome: 120_000 }),
        1_000,
        Q2_2025,
        2,
      ),
    ).toBeNull();
  });

  it('영업이익은 최신이어도 재무상태표 계정이 낡으면 null — 전사 최댓값이 아니라 계정별로 판정한다', () => {
    // latestPeriodKey(전사 최댓값)는 영업이익 최신 분기와 같은 2025Q1 로 '신선'하다.
    // 하지만 순운전자본·유형자산 계정은 2024Q3 에 머물러 있다 — 지주회사 등에서
    // 재무상태표만 갱신이 뜸한 경우를 흉내낸다. staleQuarters 라는 이름·설명이
    // 약속하는 것은 "계정이 낡으면 제외" 이지 "회사 전체 중 하나라도 최신이면 통과"
    // 가 아니므로, 이 케이스는 반드시 걸러져야 한다.
    const staleBalanceSheet = snapshot(HEALTHY, {
      latestPeriodKey: '2025Q1',
      ttmOperatingIncome: 120_000,
      fieldPeriods: {
        CURRENT_ASSETS: '2024Q3',
        CURRENT_LIABILITIES: '2024Q3',
        TANGIBLE_ASSETS: '2024Q3',
      },
    });
    // 2024Q3 → 2025Q2 는 3분기 차, staleQuarters=2 를 넘는다
    expect(computeValueQualityMetrics(staleBalanceSheet, 1_000, Q2_2025, 2)).toBeNull();
    // staleQuarters 를 재무상태표 계정 기준으로도 넉넉히 주면 통과한다
    expect(computeValueQualityMetrics(staleBalanceSheet, 1_000, Q2_2025, 8)).not.toBeNull();
  });

  it('없는 차입금·현금 계정은 0 으로 본다', () => {
    const minimal: Partial<Record<FundamentalField, number>> = {
      SHARES_OUTSTANDING: 1_000,
      CURRENT_ASSETS: 500_000,
      CURRENT_LIABILITIES: 200_000,
      TANGIBLE_ASSETS: 400_000,
    };
    const metrics = computeValueQualityMetrics(
      snapshot(minimal, { ttmOperatingIncome: 100_000 }),
      1_000,
      Q2_2025,
      2,
    );
    expect(metrics?.earningsYield).toBeCloseTo(100_000 / 1_000_000); // EV = 시가총액
  });

  it('종가가 0 이하면 null', () => {
    expect(
      computeValueQualityMetrics(snapshot(HEALTHY, { ttmOperatingIncome: 120_000 }), 0, Q2_2025, 2),
    ).toBeNull();
  });
});

describe('valueQualityRankParameters', () => {
  it('기본값만으로 파싱된다', () => {
    expect(valueQualityRankParameters.parse({})).toEqual({
      topN: 20,
      staleQuarters: 2,
    });
  });

  it('연결/별도(consolidated)는 파라미터가 아니다 — 수집 시점 선택이다', () => {
    const parsed = valueQualityRankParameters.parse({}) as Record<string, unknown>;
    expect('consolidated' in parsed).toBe(false);
  });

  it('범위 밖 값을 거부한다', () => {
    expect(valueQualityRankParameters.safeParse({ staleQuarters: 0 }).success).toBe(false);
    expect(valueQualityRankParameters.safeParse({ staleQuarters: 9 }).success).toBe(false);
    expect(valueQualityRankParameters.safeParse({ topN: 200 }).success).toBe(true);
    expect(valueQualityRankParameters.safeParse({ topN: 201 }).success).toBe(false);
  });
});

describe('레지스트리 등록', () => {
  it('JSON 스키마에 한국어 라벨과 기본값이 실린다', () => {
    const schema = new StrategyRegistry().getParameterJsonSchema('value-quality-rank');
    const properties = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.topN?.title).toBe('보유 종목 수');
    expect(properties.staleQuarters?.default).toBe(2);
  });
});

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function candleFor(symbol: string, index: number, close: number): Candle {
  return {
    symbol,
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * DAY,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

/** 한 종목의 4개 분기 재무를 모두 같은 시각에 공시된 것으로 만든다 */
function quarterlyFacts(
  symbol: string,
  asOfTsMs: number,
  quarterlyOperatingIncome: number,
  balance: Partial<Record<FundamentalField, number>>,
): Fact[] {
  const facts: Fact[] = [];
  const quarters = ['2024Q2', '2024Q3', '2024Q4', '2025Q1'];
  for (const periodKey of quarters) {
    facts.push({
      scope: 'SYMBOL',
      key: symbol,
      field: 'OPERATING_INCOME',
      periodKey,
      asOfTsMs,
      value: quarterlyOperatingIncome,
      unit: 'KRW',
    });
  }
  for (const [field, value] of Object.entries(balance)) {
    facts.push({
      scope: 'SYMBOL',
      key: symbol,
      field,
      periodKey: '2025Q1',
      asOfTsMs,
      value: value as number,
      unit: field === 'SHARES_OUTSTANDING' ? 'SHARES' : 'KRW',
    });
  }
  return facts;
}

describe('밸류·퀄리티 랭킹 실행', () => {
  const disclosed = START + 5 * DAY;
  const balance: Partial<Record<FundamentalField, number>> = {
    SHARES_OUTSTANDING: 1_000,
    CURRENT_ASSETS: 500_000,
    CURRENT_LIABILITIES: 200_000,
    TANGIBLE_ASSETS: 400_000,
  };

  // CHEAP 은 같은 이익에 주가가 싸다 → 이익수익률·ROC 둘 다 우위
  const facts: Fact[] = [
    ...quarterlyFacts('CHEAP', disclosed, 50_000, balance),
    ...quarterlyFacts('RICH', disclosed, 5_000, balance),
  ];

  function candles(bars: number): Candle[] {
    const out: Candle[] = [];
    for (let index = 0; index < bars; index += 1) {
      out.push(candleFor('CHEAP', index, 1_000));
      out.push(candleFor('RICH', index, 1_000));
    }
    return out;
  }

  const parameters = { topN: 1, staleQuarters: 2 };

  it('context.isRebalanceBar가 false면 계산 가능한 재무가 있어도 주문을 내지 않는다', () => {
    const bar = candleFor('CHEAP', 5, 1_000);
    const noRebalanceContext: StrategyBarContext = {
      tsMs: bar.tsMs,
      isRebalanceBar: false,
      bars: new Map([['CHEAP', bar]]),
      getHistory: () => [bar],
      portfolio: { cash: 10_000, equity: 10_000, positions: new Map() },
      rng: createRng(1),
      fundamentals: () => snapshot(HEALTHY, { ttmOperatingIncome: 120_000 }),
      corporateActions: () => [],
      tradableSymbols: new Set(['CHEAP']),
      activeUniverseSymbols: new Set(['CHEAP']),
      selectionMetric: () => null,
    };
    const state = valueQualityRankStrategy.initialize({
      symbols: ['CHEAP'],
      initialCash: 10_000,
      rng: createRng(1),
    });
    expect(valueQualityRankStrategy.onBars(noRebalanceContext, state, parameters).orders).toEqual([]);
  });

  it('두 지표 합산 상위만 편입한다', () => {
    const result = runBacktest(valueQualityRankStrategy, {
      candles: candles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
      facts,
      tradeFromTsMs: disclosed,
    });
    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    expect(new Set(buys.map((fill) => fill.symbol))).toEqual(new Set(['CHEAP']));
  });

  it('공시 전에는 아무것도 사지 않는다', () => {
    const result = runBacktest(valueQualityRankStrategy, {
      candles: candles(4), // 공시(5봉)보다 이른 구간만
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
      facts,
      tradeFromTsMs: disclosed,
    });
    expect(result.fills).toEqual([]);
  });

  it('facts 가 없으면 아무것도 사지 않는다 — 조용히 랭킹하지 않는다', () => {
    const result = runBacktest(valueQualityRankStrategy, {
      candles: candles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
      tradeFromTsMs: disclosed,
    });
    expect(result.fills).toEqual([]);
  });

  /**
   * 순위 **합** 이 이 전략의 공식 자체인데, 위 픽스처들은 모두 한 종목이 두 지표를
   * 동시에 이긴다 — 점수를 이익수익률 하나로 줄여도, 자본수익률 하나로 줄여도 전부
   * 통과한다. 두 지표의 순위가 서로 어긋나고 **합산 승자가 어느 단일 지표 승자와도
   * 다른** 4종목 픽스처로 그 구멍을 막는다.
   *
   * 설계: EBIT 는 네 종목 모두 100,000, 시가총액도 1,000,000(1,000주 × 1,000)으로 같다.
   * 차입금으로 EV 를, 유형자산으로 투입자본을 벌려 순위만 조정한다.
   *
   *   종목   차입금    EV        이익수익률 순위 | 유형자산  투입자본   자본수익률 순위 | 합
   *   A            0  1,000,000            1   |  400,000   700,000            4   |  5
   *   B      100,000  1,100,000            2   |  200,000   500,000            2   |  4  ← 승자
   *   D      200,000  1,200,000            3   |  300,000   600,000            3   |  6
   *   C      300,000  1,300,000            4   |  100,000   400,000            1   |  5
   *
   * 이익수익률만 보면 A, 자본수익률만 보면 C 가 1위다. 합산 승자는 B 하나뿐이다.
   */
  describe('두 지표의 순위가 어긋날 때 — 순위 합이 실제로 쓰인다', () => {
    const OPPOSED: Array<{ symbol: string; borrowings: number; tangible: number }> = [
      { symbol: 'AAA', borrowings: 0, tangible: 400_000 },
      { symbol: 'BBB', borrowings: 100_000, tangible: 200_000 },
      { symbol: 'CCC', borrowings: 300_000, tangible: 100_000 },
      { symbol: 'DDD', borrowings: 200_000, tangible: 300_000 },
    ];

    const opposedFacts: Fact[] = OPPOSED.flatMap((entry) =>
      quarterlyFacts(entry.symbol, disclosed, 25_000, {
        SHARES_OUTSTANDING: 1_000,
        CURRENT_ASSETS: 500_000,
        CURRENT_LIABILITIES: 200_000,
        TANGIBLE_ASSETS: entry.tangible,
        SHORT_TERM_BORROWINGS: entry.borrowings,
      }),
    );

    function opposedCandles(bars: number): Candle[] {
      const out: Candle[] = [];
      for (let index = 0; index < bars; index += 1) {
        for (const { symbol } of OPPOSED) out.push(candleFor(symbol, index, 1_000));
      }
      return out;
    }

    /** 픽스처가 정말 어긋나 있는지 지표 단위로 먼저 확인한다 */
    it('픽스처는 두 지표 1위가 서로 다르다 — 그래야 합산을 검증할 수 있다', () => {
      const metrics = OPPOSED.map((entry) => ({
        symbol: entry.symbol,
        ...computeValueQualityMetrics(
          snapshot(
            {
              SHARES_OUTSTANDING: 1_000,
              CURRENT_ASSETS: 500_000,
              CURRENT_LIABILITIES: 200_000,
              TANGIBLE_ASSETS: entry.tangible,
              SHORT_TERM_BORROWINGS: entry.borrowings,
            },
            { ttmOperatingIncome: 100_000 },
          ),
          1_000,
          Q2_2025,
          2,
        )!,
      }));

      const byYield = [...metrics].sort((a, b) => b.earningsYield - a.earningsYield);
      const byCapital = [...metrics].sort((a, b) => b.returnOnCapital - a.returnOnCapital);
      expect(byYield[0]?.symbol).toBe('AAA'); // 이익수익률 1위
      expect(byCapital[0]?.symbol).toBe('CCC'); // 자본수익률 1위 — 다른 종목이어야 한다
      expect(byYield.map((m) => m.symbol)).toEqual(['AAA', 'BBB', 'DDD', 'CCC']);
      expect(byCapital.map((m) => m.symbol)).toEqual(['CCC', 'BBB', 'DDD', 'AAA']);
    });

    it('합산 1위(어느 단일 지표 1위도 아닌 종목)를 편입한다', () => {
      const result = runBacktest(valueQualityRankStrategy, {
        candles: opposedCandles(40),
        initialCash: 10_000_000,
        execution: ZERO_COST,
        parameters: { topN: 1, staleQuarters: 2 },
        randomSeed: 1,
        maxPositions: 1,
        facts: opposedFacts,
        tradeFromTsMs: disclosed,
      });
      const bought = new Set(
        result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol),
      );
      // 점수를 이익수익률만으로 줄이면 AAA, 자본수익률만으로 줄이면 CCC 가 나온다
      expect(bought).toEqual(new Set(['BBB']));
    });

    it('상위 2종목도 합산 순위대로 나온다 (AAA·CCC 동점은 심볼 순으로 깬다)', () => {
      const result = runBacktest(valueQualityRankStrategy, {
        candles: opposedCandles(40),
        initialCash: 10_000_000,
        execution: ZERO_COST,
        parameters: { topN: 2, staleQuarters: 2 },
        randomSeed: 1,
        maxPositions: 2,
        facts: opposedFacts,
        tradeFromTsMs: disclosed,
      });
      const bought = new Set(
        result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol),
      );
      // 합: BBB 4 < AAA 5 = CCC 5 < DDD 6 — 2위는 동점이라 심볼 오름차순으로 AAA
      expect(bought).toEqual(new Set(['AAA', 'BBB']));
    });
  });

  it('같은 입력을 두 번 돌리면 같은 결과가 나온다 (재현성 §9.5)', () => {
    const input = {
      candles: candles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
      facts,
      tradeFromTsMs: disclosed,
    };
    expect(runBacktest(valueQualityRankStrategy, input).fills).toEqual(
      runBacktest(valueQualityRankStrategy, input).fills,
    );
  });
});

describe('멤버십 일정 반영 랭킹 (리뷰 fix — 2026-08-05)', () => {
  /**
   * A·B·C 세 종목, topN=2. 재무(EBIT·유형자산 등)는 시간이 지나도 바뀌지 않으므로
   * 자본수익률 순위는 항상 C > B > A 로 고정해둔다(유형자산을 벌려 투입자본을 다르게
   * 만든다). 이익수익률은 종가에 반사적이라 A 의 종가만 리밸런스 사이에 바꿔
   * 순위를 뒤집는다 — 1구간(reb1, day5)에는 A 종가를 비싸게(5,000) 둬서 이익수익률이
   * 바닥이라 순위 합에서 밀려나고, 2구간(reb2, Feb1=index30)에는 A 종가를 폭락(10)
   * 시켜 이익수익률이 치솟게 한다. 그런데 A 는 2구간부터 일정에서 빠진다.
   *
   * 필터링하지 않으면(구 코드): reb2 에서 A 가 원 지표만으로 순위 합 동점 1위가 돼
   * targets=[A, B] 가 된다 — 보유 중이던 C 가 팔리고 A 매수는 엔진이 거부해 그 몫의
   * 예산이 그대로 현금으로 논다(topN=2 인데 실보유는 B 하나로 줄어든다).
   * 필터링하면 후보가 {B, C} 뿐이라 이미 topN(=2) 을 정확히 채우고 있어 아무 것도
   * 바뀌지 않는다 — 이 테스트가 검증하는 동작(cross-sectional-momentum.test.ts 의
   * 같은 이름 describe 와 같은 취지, 후보 생성 로직이 달라 별도로 검증한다).
   */
  const disclosedForMembership = START + 5 * DAY;

  function membershipBalance(tangibleAssets: number): Partial<Record<FundamentalField, number>> {
    return {
      SHARES_OUTSTANDING: 1_000,
      CURRENT_ASSETS: 500_000,
      CURRENT_LIABILITIES: 200_000,
      TANGIBLE_ASSETS: tangibleAssets,
    };
  }

  // 투입자본: A(300,000+700,000=1,000,000) > B(300,000+400,000=700,000) > C(300,000+100,000=400,000)
  // EBIT(TTM) 100,000 은 셋 다 같다 → ROC: C(0.25) > B(0.1429) > A(0.10), 시간과 무관하게 고정.
  const membershipFacts: Fact[] = [
    ...quarterlyFacts('A', disclosedForMembership, 25_000, membershipBalance(700_000)),
    ...quarterlyFacts('B', disclosedForMembership, 25_000, membershipBalance(400_000)),
    ...quarterlyFacts('C', disclosedForMembership, 25_000, membershipBalance(100_000)),
  ];

  // A 종가만 구간 전환에 맞춰 바뀐다 — index 30(2구간 시작) 부터 폭락시켜 이익수익률을
  // 뒤집는다. B·C 는 끝까지 그대로다.
  function membershipCandles(bars: number): Candle[] {
    const out: Candle[] = [];
    for (let index = 0; index < bars; index += 1) {
      out.push(candleFor('A', index, index < 30 ? 5_000 : 10));
      out.push(candleFor('B', index, 100));
      out.push(candleFor('C', index, 200));
    }
    return out;
  }

  it('2구간에서 유니버스 탈락 종목은 랭킹 후보에서도 빠져 차순위가 슬롯을 지킨다', () => {
    const result = runBacktest(valueQualityRankStrategy, {
      candles: membershipCandles(35),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { topN: 2, staleQuarters: 2 },
      randomSeed: 1,
      maxPositions: 2,
      facts: membershipFacts,
      universeSchedule: [
        { fromTsMs: disclosedForMembership, symbols: ['A', 'B', 'C'] },
        { fromTsMs: START + 30 * DAY, symbols: ['B', 'C'] },
      ],
    });

    // 1구간 리밸런스(day5) — A 는 원 지표로도 순위 합 최하위라 필터 유무와 무관하게
    // B·C 만 편입된다.
    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(new Set(buys.map((fill) => fill.symbol))).toEqual(new Set(['B', 'C']));

    // 2구간 전환(index30) 이후 — A 는 원 지표만 보면 순위 합 동점 1위이지만 일정에서
    // 빠져 랭킹 후보에도 들지 못한다: A 매수 시도도, 그로 인한 C 매도도 일어나지 않는다.
    expect(result.fills.some((fill) => fill.symbol === 'A')).toBe(false);
    expect(result.fills.filter((fill) => fill.symbol === 'C' && fill.side === 'SELL')).toHaveLength(0);
    expect(
      result.warnings.some((warning) => warning.includes('A') && warning.includes('멤버십 일정')),
    ).toBe(false);

    // topN(=2) 슬롯이 그대로 유지된다 — 필터링하지 않으면 C 가 팔리고 A 매수가
    // 거부돼 보유 종목이 1개로 줄어든다(그만큼 예산이 현금으로 논다).
    expect(result.openPositions).toHaveLength(2);
    expect(new Set(result.openPositions.map((position) => position.symbol))).toEqual(
      new Set(['B', 'C']),
    );
  });
});
