import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/server/modules/backtest/domain/seeded-rng.js';
import type { Position, SelectionMetricPin } from '../../src/server/modules/backtest/domain/types.js';
import type { FundamentalField, FundamentalSnapshot } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import {
  lowPerHighRoeRankParameters,
  lowPerHighRoeRankStrategy,
} from '../../src/server/modules/strategy/strategies/low-per-high-roe-rank.js';
import {
  rankLowPerHighRoe,
  scoreLowPerHighRoe,
} from '../../src/server/modules/strategy/strategies/shared/fundamental-rank.js';

const AT = Date.UTC(2025, 0, 2);

function snapshot(netIncomeTtm: number, totalEquity: number, periodKey = '2024Q4'): FundamentalSnapshot {
  return {
    latestPeriodKey: periodKey,
    latestAsOfTsMs: AT,
    get: (field) => (field === 'TOTAL_EQUITY' ? totalEquity : null),
    quarter: (field, offset = 0) => {
      if (field !== 'NET_INCOME' || offset > 3) return null;
      return { periodKey, value: netIncomeTtm / 4 };
    },
    ttm: (field) => (field === 'NET_INCOME' ? netIncomeTtm : null),
    periodKeyOf: (field: FundamentalField) =>
      field === 'NET_INCOME' || field === 'TOTAL_EQUITY' ? periodKey : null,
  };
}

function context(input: {
  candidates: Readonly<Record<string, { marketCapKrw: string; netIncomeTtm: number; totalEquity: number; netPeriod?: string; equityPeriod?: string }>>;
  isRebalanceBar: boolean;
  positions?: ReadonlyMap<string, Position>;
}): StrategyBarContext {
  const bars = new Map<string, Candle>();
  for (const symbol of Object.keys(input.candidates)) {
    bars.set(symbol, {
      symbol,
      market: 'KR',
      timeframe: '1d',
      tsMs: AT,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1_000,
    });
  }
  return {
    tsMs: AT,
    isRebalanceBar: input.isRebalanceBar,
    bars,
    getHistory: (symbol) => {
      const bar = bars.get(symbol);
      return bar ? [bar] : [];
    },
    portfolio: { cash: 10_000, equity: 10_000, positions: input.positions ?? new Map() },
    rng: createRng(1),
    fundamentals: (symbol) => {
      const row = input.candidates[symbol];
      if (!row) return null;
      const base = snapshot(row.netIncomeTtm, row.totalEquity, row.netPeriod ?? '2024Q4');
      return {
        ...base,
        periodKeyOf: (field: FundamentalField) => {
          if (field === 'NET_INCOME') return row.netPeriod ?? '2024Q4';
          if (field === 'TOTAL_EQUITY') return row.equityPeriod ?? '2024Q4';
          return null;
        },
      };
    },
    corporateActions: () => [],
    tradableSymbols: new Set(Object.keys(input.candidates)),
    activeUniverseSymbols: new Set(Object.keys(input.candidates)),
    selectionMetric: (symbol): SelectionMetricPin | null => {
      const row = input.candidates[symbol];
      return row
        ? { marketCapKrw: row.marketCapKrw, volume: null, tradingValueKrw: null }
        : null;
    },
  };
}

describe('scoreLowPerHighRoe', () => {
  it('안전한 시가총액으로 PER과 ROE를 계산한다', () => {
    expect(scoreLowPerHighRoe({ marketCapKrw: '1000', netIncomeTtm: 100, totalEquity: 500 })).toEqual({
      per: 10,
      roe: 0.2,
    });
  });

  it('시가총액은 양의 bigint이면서 Number.MAX_SAFE_INTEGER 이하일 때만 변환한다', () => {
    const maximum = String(Number.MAX_SAFE_INTEGER);
    expect(scoreLowPerHighRoe({ marketCapKrw: maximum, netIncomeTtm: 1, totalEquity: 1 })?.per).toBe(Number.MAX_SAFE_INTEGER);
    for (const marketCapKrw of ['0', '-1', '9007199254740992', '1.5', '1e3', 'not-a-number']) {
      expect(scoreLowPerHighRoe({ marketCapKrw, netIncomeTtm: 100, totalEquity: 500 }), marketCapKrw).toBeNull();
    }
  });

  it('TTM 순이익과 자본총계는 모두 유한한 양수여야 한다', () => {
    expect(scoreLowPerHighRoe({ marketCapKrw: '1000', netIncomeTtm: -1, totalEquity: 500 })).toBeNull();
    expect(scoreLowPerHighRoe({ marketCapKrw: '1000', netIncomeTtm: 0, totalEquity: 500 })).toBeNull();
    expect(scoreLowPerHighRoe({ marketCapKrw: '1000', netIncomeTtm: 100, totalEquity: 0 })).toBeNull();
    expect(scoreLowPerHighRoe({ marketCapKrw: '1000', netIncomeTtm: Number.NaN, totalEquity: 500 })).toBeNull();
    expect(scoreLowPerHighRoe({ marketCapKrw: '1000', netIncomeTtm: 100, totalEquity: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('rankLowPerHighRoe', () => {
  it('낮은 PER과 높은 ROE의 ordinal rank 합을 쓰고 최종 동점은 코드 순이다', () => {
    expect(
      rankLowPerHighRoe([
        { symbol: 'A', marketCapKrw: '1000', netIncomeTtm: 100, totalEquity: 500 },
        { symbol: 'B', marketCapKrw: '2000', netIncomeTtm: 100, totalEquity: 400 },
      ]).map((row) => row.symbol),
    ).toEqual(['A', 'B']);
  });

  it('계산 불가능한 종목은 순위에서 제외한다', () => {
    expect(
      rankLowPerHighRoe([
        { symbol: 'VALID', marketCapKrw: '1000', netIncomeTtm: 100, totalEquity: 500 },
        { symbol: 'LOSS', marketCapKrw: '1', netIncomeTtm: -1, totalEquity: 1 },
      ]).map((row) => row.symbol),
    ).toEqual(['VALID']);
  });
});

describe('저PER·고ROE 전략', () => {
  it('스키마와 준비 데이터 요구가 정확하다', () => {
    expect(lowPerHighRoeRankStrategy.version).toBe('1.2.2');
    expect(lowPerHighRoeRankParameters.parse({})).toEqual({ topN: 40, staleQuarters: 2 });
    expect(lowPerHighRoeRankParameters.safeParse({ topN: 200, staleQuarters: 1 }).success).toBe(true);
    expect(lowPerHighRoeRankParameters.safeParse({ staleQuarters: 0 }).success).toBe(false);
    expect(lowPerHighRoeRankParameters.safeParse({ topN: 201 }).success).toBe(false);
    expect(lowPerHighRoeRankParameters.safeParse({ staleQuarters: 9 }).success).toBe(false);
    expect(lowPerHighRoeRankStrategy.dataRequirements).toEqual({
      fundamentalLookbackQuarters: 4,
      requiresCorporateActions: true,
    });
  });

  it('실제 두 단계 리밸런스도 PER·ROE 순위 합과 seeded 동점을 쓰고 unsafe cap을 제외한다', () => {
    const candidates = {
      AAA: { marketCapKrw: '1000', netIncomeTtm: 100, totalEquity: 500 },
      BBB: { marketCapKrw: '2000', netIncomeTtm: 100, totalEquity: 250 },
      CCC: { marketCapKrw: '4000', netIncomeTtm: 100, totalEquity: 200 },
      DDD: { marketCapKrw: '3000', netIncomeTtm: 100, totalEquity: 100 / 0.3 },
      // Number('1e1')로 바로 바꾸면 PER·ROE 모두 1위가 되지만 bigint text 계약에는 위반이다.
      UNSAFE: { marketCapKrw: '1e1', netIncomeTtm: 100, totalEquity: 100 },
    };
    const state = lowPerHighRoeRankStrategy.initialize({
      symbols: Object.keys(candidates),
      initialCash: 10_000,
      rng: createRng(1),
    });
    const parameters = { topN: 2, staleQuarters: 2 };

    expect(
      lowPerHighRoeRankStrategy.onBars(
        context({ candidates, isRebalanceBar: true }),
        state,
        parameters,
      ).orders,
    ).toEqual([]);
    const buyDecision = lowPerHighRoeRankStrategy.onBars(
      context({ candidates, isRebalanceBar: false }),
      state,
      parameters,
    );
    // 합: BBB 4 < AAA 5 = CCC 5 < DDD 6 — seed 1은 2위 동점에서 AAA를 고른다.
    expect(buyDecision.orders.map((order) => order.symbol)).toEqual(['AAA', 'BBB']);
    expect(buyDecision.orders[0]).toMatchObject({ side: 'BUY', quantity: 50 });
  });

  it('순이익이나 자본총계 공시가 stale이면 후보에서 제외한다', () => {
    const candidates = {
      FRESH: { marketCapKrw: '2000', netIncomeTtm: 100, totalEquity: 500 },
      STALE_NET: {
        marketCapKrw: '1000',
        netIncomeTtm: 100,
        totalEquity: 500,
        netPeriod: '2024Q2',
      },
      STALE_EQUITY: {
        marketCapKrw: '1000',
        netIncomeTtm: 100,
        totalEquity: 500,
        equityPeriod: '2024Q2',
      },
    };
    const state = lowPerHighRoeRankStrategy.initialize({
      symbols: Object.keys(candidates),
      initialCash: 10_000,
      rng: createRng(1),
    });
    const parameters = { topN: 1, staleQuarters: 2 };
    lowPerHighRoeRankStrategy.onBars(context({ candidates, isRebalanceBar: true }), state, parameters);
    const buy = lowPerHighRoeRankStrategy.onBars(
      context({ candidates, isRebalanceBar: false }),
      state,
      parameters,
    );
    expect(buy.orders.map((order) => order.symbol)).toEqual(['FRESH']);
  });

  it('재무 후보가 전부 stale이면 기존 보유를 전량 매도하지 않는다', () => {
    const candidates = {
      STALE: {
        marketCapKrw: '1000',
        netIncomeTtm: 100,
        totalEquity: 500,
        netPeriod: '2024Q1',
        equityPeriod: '2024Q1',
      },
    };
    const state = lowPerHighRoeRankStrategy.initialize({
      symbols: ['STALE'],
      initialCash: 10_000,
      rng: createRng(1),
    });
    const positions = new Map<string, Position>([
      ['STALE', {
        symbol: 'STALE', quantity: 10, avgEntryPrice: 100, entryCosts: 0, entryTsMs: AT,
      }],
    ]);
    const decision = lowPerHighRoeRankStrategy.onBars(
      context({ candidates, isRebalanceBar: true, positions }),
      state,
      { topN: 1, staleQuarters: 2 },
    );
    expect(decision.orders).toEqual([]);
    expect(state.pendingTargets).toBeNull();
  });

  it('재무가 있지만 적자라 유효하게 순위 탈락한 보유분은 매도한다', () => {
    const candidates = {
      LOSS: { marketCapKrw: '1000', netIncomeTtm: -100, totalEquity: 500 },
    };
    const state = lowPerHighRoeRankStrategy.initialize({
      symbols: ['LOSS'],
      initialCash: 10_000,
      rng: createRng(1),
    });
    const positions = new Map<string, Position>([
      ['LOSS', {
        symbol: 'LOSS', quantity: 10, avgEntryPrice: 100, entryCosts: 0, entryTsMs: AT,
      }],
    ]);
    const decision = lowPerHighRoeRankStrategy.onBars(
      context({ candidates, isRebalanceBar: true, positions }),
      state,
      { topN: 1, staleQuarters: 2 },
    );
    expect(decision.orders).toEqual([
      { symbol: 'LOSS', side: 'SELL', quantity: 10, reason: 'REBALANCE_EXIT' },
    ]);
  });

  it('리밸런스 봉이 아니고 대기 매수도 없으면 주문을 내지 않는다', () => {
    const candidates = {
      A: { marketCapKrw: '1000', netIncomeTtm: 100, totalEquity: 500 },
    };
    const state = lowPerHighRoeRankStrategy.initialize({
      symbols: ['A'],
      initialCash: 10_000,
      rng: createRng(1),
    });
    expect(
      lowPerHighRoeRankStrategy.onBars(
        context({ candidates, isRebalanceBar: false }),
        state,
        { topN: 1, staleQuarters: 2 },
      ).orders,
    ).toEqual([]);
  });
});
