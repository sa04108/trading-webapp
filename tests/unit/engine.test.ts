import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest, runBacktestCancellable } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile, OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../src/server/modules/facts/domain/fact.js';
import { PitFactView } from '../../src/server/modules/facts/domain/pit-fact-view.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type {
  StrategyBarContext,
  TradingStrategy,
} from '../../src/server/modules/strategy/domain/strategy.js';
import {
  rangeBreakoutStrategy,
  type RangeBreakoutParameters,
} from '../../src/server/modules/strategy/strategies/range-breakout.js';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 6, 6, 0, 0);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function bar(index: number, price: number, overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: 'A',
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * HOUR,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume: 100,
    ...overrides,
  };
}

const DAY = 86_400_000;

/**
 * 자본변동 테스트 전용 봉 헬퍼다. 기존 `bar()` 는 봉 간격이 한 시간이라
 * 효력발생일이 어느 봉 사이에 떨어지는지 통제할 수 없다.
 * 하루 간격으로 띄워야 효력 시각을 원하는 봉 경계에 정확히 맞출 수 있다.
 */
function dailyBar(index: number, price: number): Candle {
  return { ...bar(index, price), tsMs: START + index * DAY };
}

/** 자본변동 테스트용 SPLIT_RATIO 팩트. asOfTsMs 는 게이트에 쓰이지 않으므로 아무 값이나 둔다 */
function splitFact(symbol: string, periodKey: string, ratio: number): Fact {
  return {
    scope: 'SYMBOL',
    key: symbol,
    field: CORPORATE_ACTION_FIELD,
    periodKey,
    asOfTsMs: START,
    value: ratio,
    unit: 'ratio',
  };
}

/** 지정한 봉 index 종가에서 1주 매수하는 테스트 전략 */
function buyAtBarStrategy(buyIndex: number, quantity = 1): TradingStrategy<unknown, { seen: number }> {
  return {
    id: 'test-buy',
    version: '1.0.0',
    name: 'test',
    description: 'test',
    parameterSchema: z.unknown(),
    initialize: () => ({ seen: 0 }),
    onBars(context, state) {
      const orders: OrderIntent[] = [];
      if (state.seen === buyIndex) {
        orders.push({ symbol: 'A', side: 'BUY', quantity });
      }
      state.seen += 1;
      return { orders };
    },
  };
}

describe('runBacktest 이벤트 순서 (스펙 §9.1, §9.2)', () => {
  it('fills at the NEXT bar open, never the signal bar close', () => {
    const candles = [bar(0, 100), bar(1, 110), bar(2, 120)];
    const result = runBacktest(buyAtBarStrategy(0) as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    });

    expect(result.fills).toHaveLength(1);
    const fill = result.fills[0]!;
    expect(fill.tsMs).toBe(START + HOUR); // 신호 봉(0) 이 아니라 다음 봉(1)
    expect(fill.price).toBe(110); // 다음 봉 시가
  });

  it('keeps pending orders until the next tradable bar (결측 봉 대기)', () => {
    // 봉 1 이 없음 → 봉 2 시가에서 체결
    const candles = [bar(0, 100), bar(2, 120)];
    const result = runBacktest(buyAtBarStrategy(0) as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.tsMs).toBe(START + 2 * HOUR);
  });

  it('reduces quantity when cash is insufficient (현금 부족)', () => {
    const candles = [bar(0, 100), bar(1, 100)];
    const result = runBacktest(buyAtBarStrategy(0, 1_000) as never, {
      candles,
      initialCash: 550, // 100원짜리 1000주 주문 → 5주만 가능
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.quantity).toBe(5);
  });

  it('rejects BUY when cash cannot afford even the minimum quantity', () => {
    const candles = [bar(0, 100), bar(1, 100)];
    const result = runBacktest(buyAtBarStrategy(0, 10) as never, {
      candles,
      initialCash: 50,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    });
    expect(result.fills).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('현금 부족'))).toBe(true);
  });

  it('never exposes future bars to the strategy (look-ahead 방지)', () => {
    const candles = Array.from({ length: 20 }, (_, i) => bar(i, 100 + i));
    let violations = 0;

    const spyStrategy: TradingStrategy<unknown, null> = {
      id: 'spy',
      version: '1.0.0',
      name: 'spy',
      description: 'spy',
      parameterSchema: z.unknown(),
      initialize: () => null,
      onBars(context: StrategyBarContext) {
        const history = context.getHistory('A');
        for (const candle of history) {
          if (candle.tsMs > context.tsMs) violations += 1;
        }
        for (const [, candle] of context.bars) {
          if (candle.tsMs !== context.tsMs) violations += 1;
        }
        return { orders: [] };
      },
    };

    runBacktest(spyStrategy as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    });
    expect(violations).toBe(0);
  });

  it('records a round-trip trade with costs', () => {
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'roundtrip',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] =
          state.step === 0
            ? [{ symbol: 'A', side: 'BUY', quantity: 10 }]
            : state.step === 2
              ? [{ symbol: 'A', side: 'SELL', quantity: 10 }]
              : [];
        state.step += 1;
        return { orders };
      },
    };

    const withCosts: ExecutionProfile = {
      cost: {
        id: 'c',
        version: '1',
        buyCommissionRate: 0.001,
        sellCommissionRate: 0.001,
        sellTaxRate: 0.002,
      },
      slippage: { id: 's', version: '1', bps: 0, fixed: 0 },
      rules: { tickSize: 0, minOrderQty: 1 },
    };

    const candles = [bar(0, 100), bar(1, 100), bar(2, 110), bar(3, 120)];
    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000,
      execution: withCosts,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.entryPrice).toBe(100);
    expect(trade.exitPrice).toBe(120); // 봉3 시가
    expect(trade.grossPnl).toBeCloseTo(200);
    // 비용: 매수 수수료 1 + 매도 수수료 1.2 + 세금 2.4
    expect(trade.costs).toBeCloseTo(1 + 1.2 + 2.4);
    expect(trade.netPnl).toBeCloseTo(200 - 4.6);
    // 최종 equity = 초기 + netPnl
    expect(result.metrics.finalEquity).toBeCloseTo(10_000 + 200 - 4.6);
  });

  it('reports open positions at period end with mark-to-market PnL', () => {
    // 봉 0 신호 → 봉 1 시가(110) 체결, 이후 청산 없음 — 마지막 종가 130 기준 평가
    const candles = [bar(0, 100), bar(1, 110), bar(2, 130)];
    const result = runBacktest(buyAtBarStrategy(0, 5) as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    });

    expect(result.openPositions).toHaveLength(1);
    expect(result.openPositions[0]).toEqual({
      symbol: 'A',
      quantity: 5,
      avgEntryPrice: 110,
      entryTsMs: START + HOUR,
      lastPrice: 130,
      unrealizedPnl: 5 * (130 - 110),
      returnPct: ((130 - 110) / 110) * 100,
    });
  });

  it('reports no open positions when everything was closed', () => {
    const candles = [bar(0, 100), bar(1, 110), bar(2, 120)];
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'test-roundtrip',
      version: '1.0.0',
      name: 'test',
      description: 'test',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] =
          state.step === 0
            ? [{ symbol: 'A', side: 'BUY', quantity: 1 }]
            : state.step === 1
              ? [{ symbol: 'A', side: 'SELL', quantity: 1 }]
              : [];
        state.step += 1;
        return { orders };
      },
    };
    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    });
    expect(result.openPositions).toEqual([]);
  });

  it('counts pending BUY orders against maxPositions (동시 신호 상한 방어)', () => {
    // 두 심볼이 같은 봉에서 동시에 BUY 신호 → maxPositions=1 이면 1건만 체결돼야 한다
    const strategy: TradingStrategy<unknown, { fired: boolean }> = {
      id: 'dual-buy',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ fired: false }),
      onBars(_context, state) {
        if (state.fired) return { orders: [] };
        state.fired = true;
        return {
          orders: [
            { symbol: 'A', side: 'BUY' as const, quantity: 1 },
            { symbol: 'B', side: 'BUY' as const, quantity: 1 },
          ],
        };
      },
    };

    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
    ];
    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 1,
    });

    expect(result.fills).toHaveLength(1);
    expect(result.metrics.maxConcurrentPositions).toBeLessThanOrEqual(1);

    // 상한에 걸려 버려진 주문은 조용히 사라지면 안 된다 — 그만큼 자본이 현금으로
    // 남는데 자산 곡선은 정상처럼 보인다. 어느 종목이 몇 건 폐기됐는지 밝힌다.
    const capWarning = result.warnings.find((warning) => warning.includes('동시 보유 종목 상한'));
    expect(capWarning).toBeDefined();
    expect(capWarning).toContain('B'); // A 가 슬롯을 먼저 잡으므로 B 가 폐기된다
    expect(capWarning).toContain('매수 주문 1건');
  });

  it('상한에 걸린 주문이 없으면 상한 경고를 만들지 않는다', () => {
    const result = runBacktest(buyAtBarStrategy(0) as never, {
      candles: [bar(0, 100), bar(1, 100)],
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    });
    expect(result.warnings.some((warning) => warning.includes('동시 보유 종목 상한'))).toBe(false);
  });

  it('is deterministic: same input and seed produce identical results (스펙 §9.5)', () => {
    const candles = Array.from({ length: 300 }, (_, i) =>
      bar(i, 100 + 10 * Math.sin(i / 7) + (i % 13)),
    );
    const parameters: RangeBreakoutParameters = {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      trailAtrMultiplier: 2,
      riskPerTradePercent: 2,
      maxPositionWeightPercent: 20,
    };

    const run = () =>
      runBacktest(rangeBreakoutStrategy as never, {
        candles,
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters,
        randomSeed: 42,
        maxPositions: 5,
      });

    const first = run();
    const second = run();

    const hash = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');

    expect(first.trades.length).toBeGreaterThan(0); // 시나리오가 실제 거래를 생성해야 의미 있음
    expect(hash(first.trades)).toBe(hash(second.trades));
    expect(hash(first.equityPoints)).toBe(hash(second.equityPoints));
    expect(hash(first.metrics)).toBe(hash(second.metrics));
  });
});

describe('range-breakout 갭 진입 손·익절 기준 (Codex 리뷰)', () => {
  it('anchors stop/take-profit to the actual fill price, not the signal close', () => {
    // 평탄 20봉(ATR≈2) → 신호봉 close 105 → 다음 봉 시가 130 으로 갭 진입 → 115 로 하락.
    // 신호봉 기준이면 TP(105+3×ATR≈113.4)에 걸려 손실이 TAKE_PROFIT 으로 라벨되고,
    // 체결가 기준이면 stop(130-2×ATR≈124.4)에 걸려 STOP 으로 기록돼야 한다.
    const flat = Array.from({ length: 20 }, (_, i) =>
      bar(i, 100, { open: 100, high: 101, low: 99, close: 100 }),
    );
    const signal = bar(20, 105, { open: 100, high: 106, low: 100, close: 105 });
    const gapUp = bar(21, 130, { open: 130, high: 131, low: 129, close: 130 });
    const drop = bar(22, 115, { open: 115, high: 116, low: 114, close: 115 });
    const exitBar = bar(23, 115, { open: 115, high: 116, low: 114, close: 115 });

    const parameters: RangeBreakoutParameters = {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      trailAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      riskPerTradePercent: 2,
      maxPositionWeightPercent: 100,
    };

    const result = runBacktest(rangeBreakoutStrategy as never, {
      candles: [...flat, signal, gapUp, drop, exitBar],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 42,
      maxPositions: 5,
    });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.entryPrice).toBe(130); // 갭 봉 시가 체결
    expect(trade.exitReason).toBe('STOP');
    expect(trade.netPnl).toBeLessThan(0); // 라벨과 손익 부호가 일치해야 한다
  });
});

describe('range-breakout look-ahead fixture (스펙 §33)', () => {
  it('does not enter before a future spike', () => {
    // 40개 평탄한 봉 뒤 41번째 봉에서 급등
    const flat = Array.from({ length: 40 }, (_, i) => bar(i, 100));
    const spikeIndex = 40;
    const spike = bar(spikeIndex, 100, {
      open: 100,
      high: 160,
      low: 100,
      close: 150,
      volume: 1_000,
    });
    const after = [bar(41, 152), bar(42, 155)];

    const parameters: RangeBreakoutParameters = {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      trailAtrMultiplier: 2,
      riskPerTradePercent: 2,
      maxPositionWeightPercent: 100,
    };

    const result = runBacktest(rangeBreakoutStrategy as never, {
      candles: [...flat, spike, ...after],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 42,
      maxPositions: 5,
    });

    const buyFills = result.fills.filter((f) => f.side === 'BUY');
    expect(buyFills.length).toBeGreaterThan(0);
    // 급등 봉(신호)은 index 40 → 체결은 그 다음 봉(41) 이후여야 한다
    const spikeTs = START + spikeIndex * HOUR;
    for (const fill of buyFills) {
      expect(fill.tsMs).toBeGreaterThan(spikeTs);
    }
  });
});

describe('취소 (D-042) — runBacktestCancellable', () => {
  it('실행 도중 취소 요청이 들어오면 중단한다 — 동기 드라이버는 같은 신호를 볼 틈이 없다', async () => {
    // CANCEL_YIELD_INTERVAL_BARS(200) 보다 훨씬 많은 봉이 있어야 양보 창이 여러 번 열린다.
    const manyBars = Array.from({ length: 1_000 }, (_, i) => bar(i, 100));
    const input = {
      candles: manyBars,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
    };

    // 마이크로태스크로 뒤집는다 — setTimeout 등 실제 타이머 해상도에 기대면 CI 에서
    // flaky 해진다. 마이크로태스크 큐는 첫 `await setImmediate` 로 콜스택이 비는
    // 순간 곧바로 비워지므로 실행 순서가 결정적이다.
    let asyncCancel = false;
    void Promise.resolve().then(() => {
      asyncCancel = true;
    });
    const asyncResult = await runBacktestCancellable(buyAtBarStrategy(-1) as never, input, {
      shouldCancel: () => asyncCancel,
    });
    expect(asyncResult.cancelled).toBe(true);
    expect(asyncResult.processedBars).toBeLessThan(manyBars.length);

    // 같은 신호원(마이크로태스크)을 동기 드라이버에 걸어도 뒤집히지 않는다.
    // `runBacktest` 는 제너레이터를 한 호흡에 끝까지 비운다.
    // 이벤트 루프에 양보하는 지점이 없다.
    // 그 신호가 도착할 콜스택의 빈틈 자체가 생기지 않는다 — D-042 가 고친 버그의
    // 반대쪽이다.
    let syncCancel = false;
    void Promise.resolve().then(() => {
      syncCancel = true;
    });
    const syncResult = runBacktest(buyAtBarStrategy(-1) as never, input, {
      shouldCancel: () => syncCancel,
    });
    expect(syncResult.cancelled).toBe(false);
    expect(syncResult.processedBars).toBe(manyBars.length);
  });
});

describe('분할을 걸친 보유 포지션 조정', () => {
  // 아래 모든 테스트는 periodKey '2026-07-08' 을 쓴다.
  // localDateToUtcMs 가 거래소 현지 자정을 UTC 로 옮기므로 효력 시각이 하루 밀린다.
  // 그래서 이 날짜의 효력 시각은 dailyBar(1) 초과, dailyBar(2) 이하에 떨어진다.
  // 분할은 봉 2 부터 적용된다.
  const SPLIT_PERIOD_KEY = '2026-07-08';

  it('효력발생일이 의도한 봉 사이에 떨어진다', () => {
    const view = new PitFactView([splitFact('A', SPLIT_PERIOD_KEY, 5)]);
    const [action] = view.corporateActions('A', dailyBar(2, 20_000).tsMs);
    expect(action).toBeDefined();
    expect(action!.effectiveTsMs).toBeGreaterThan(dailyBar(1, 100_000).tsMs);
    expect(action!.effectiveTsMs).toBeLessThanOrEqual(dailyBar(2, 20_000).tsMs);
    // 직전 봉 이전에는 아직 노출되지 않는다 — 위 경계 확인의 반대쪽
    expect(view.corporateActions('A', dailyBar(1, 100_000).tsMs)).toHaveLength(0);
  });

  it('분할일을 걸쳐 보유하면 평가금액이 이어진다', () => {
    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 20_000),
      dailyBar(3, 20_000),
    ];
    const result = runBacktest(buyAtBarStrategy(0, 10) as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    // 분할 직전(봉1)과 직후(봉2) 종가 기준 평가금액이 같아야 한다.
    // 5:1 분할로 종가가 1/5 이 됐지만 보유 수량도 5배가 됐으니 상쇄된다.
    expect(result.equityPoints[1]!.equity).toBe(result.equityPoints[2]!.equity);
  });

  it('분할일 매도는 조정된 수량으로 체결된다', () => {
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'split-sell',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] =
          state.step === 0
            ? [{ symbol: 'A', side: 'BUY', quantity: 10 }]
            : state.step === 2
              ? [{ symbol: 'A', side: 'SELL', quantity: 999_999 }] // 전량 매도 의도 — 실제 보유량으로 잘린다
              : [];
        state.step += 1;
        return { orders };
      },
    };

    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 20_000),
      dailyBar(3, 20_000),
    ];
    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    const sellFill = result.fills.find((fill) => fill.side === 'SELL');
    expect(sellFill).toBeDefined();
    expect(sellFill!.quantity).toBe(50); // 10주 × 5 — 분할로 조정된 수량
    // avgEntryPrice 도 20_000 으로 조정돼야 체결가(20_000)와 맞아 손익이 0 이다.
    // avgEntryPrice 조정을 빼면 100_000 이 그대로 남아 손익이 -4,000,000 으로 틀린다.
    // 위의 quantity 단언만으로는 이 회귀를 잡지 못한다.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.netPnl).toBeCloseTo(0);
  });

  it('분할 후 진입한 포지션은 그 분할의 영향을 받지 않는다', () => {
    // 봉 5 를 더 붙인다. buyAtBarStrategy(3) 은 봉 3 발행 → 봉 4 체결이다.
    // 봉 4 가 마지막 봉이면 조정 루프가 이 포지션을 한 번도 훑지 않는다.
    // 그러면 주문 등록 시점의 커서 초기화(리스크 검증 구간)를 지워도 통과해버린다.
    // 봉 5 를 더해야 조정 루프가 이 포지션을 실제로 훑어 판별력이 생긴다.
    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 20_000),
      dailyBar(3, 20_000),
      dailyBar(4, 20_000),
      dailyBar(5, 20_000),
    ];
    const result = runBacktest(buyAtBarStrategy(3, 10) as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.quantity).toBe(10); // 분할 이후 진입 — 조정 대상이 아니다
    expect(result.openPositions).toHaveLength(1);
    expect(result.openPositions[0]!.quantity).toBe(10);
    expect(result.openPositions[0]!.avgEntryPrice).toBe(20_000);
  });

  it('거래정지로 효력발생일에 봉이 없어도 거래 재개 봉에서 조정된다', () => {
    // 봉 2(효력발생일)에서 A 의 봉만 뺀다.
    // A 하나만 쓰면 그 시각 자체가 타임라인에서 사라진다.
    // 전역 커서를 쓰던 옛 코드도 그 시각을 지난 적이 없어 재개 봉에서
    // 우연히 통과해버린다 — 이 픽스처가 그 구멍을 막는다.
    // B 를 봉 2 에 심어 타임라인에 그 시각을 남긴다.
    // 전역 커서라면 봉 2 를 지나며 전진해 A 의 이벤트를 놓친다.
    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      { ...dailyBar(2, 20_000), symbol: 'B' },
      dailyBar(3, 20_000),
    ];
    const result = runBacktest(buyAtBarStrategy(0, 10) as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    // 재개 봉(3) 시가를 fractionPrice 로 써서 조정한다 — 수량 × 단가는 보존된다.
    const positionA = result.openPositions.find((position) => position.symbol === 'A');
    expect(positionA).toBeDefined();
    expect(positionA!.quantity).toBe(50);
    expect(positionA!.avgEntryPrice).toBe(20_000);
  });

  it('분할 봉 이전에 발행한 매도가 분할 봉에서 조정된 수량으로 체결된다', () => {
    // 조정이 체결보다 먼저인지 검증한다.
    // 매도는 봉 1 에서 발행돼 분할 봉(봉 2)에서 체결된다.
    // 발행 시점엔 아직 분할 전이라 quantity 가 10 으로 굳어 pendingOrders 에 들어간다.
    //
    // 그 굳은 수량도 분할 봉에서 같은 비율로 스케일해야 한다.
    // 체결 순서와 대기 주문 스케일, 두 가지를 테스트 하나로 함께 검증한다.
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'presplit-sell',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] =
          state.step === 0
            ? [{ symbol: 'A', side: 'BUY', quantity: 10 }]
            : state.step === 1
              ? [{ symbol: 'A', side: 'SELL', quantity: 10 }]
              : [];
        state.step += 1;
        return { orders };
      },
    };

    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 20_000),
      dailyBar(3, 20_000),
    ];
    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    const sellFill = result.fills.find((fill) => fill.side === 'SELL');
    expect(sellFill).toBeDefined();
    expect(sellFill!.tsMs).toBe(dailyBar(2, 20_000).tsMs); // 분할 봉에서 체결
    expect(sellFill!.quantity).toBe(50); // 발행 시점의 10 이 아니라 조정된 50
  });

  it('분할 봉 이전에 발행한 매수도 분할 봉에서 조정된 수량으로 체결된다', () => {
    // BUY 도 SELL 과 같은 값 보존 규칙을 적용한다 — 발행 시점 가격 기준으로
    // 정한 수량이 분할 후에도 같은 투입 금액을 의미하게 하려면 그렇다.
    // 4주 × 100_000 = 400_000 을 의도했다면, 분할 후에는 20주 × 20_000 이
    // 같은 400_000 이다.
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'presplit-buy',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] =
          state.step === 0
            ? [{ symbol: 'A', side: 'BUY', quantity: 10 }]
            : state.step === 1
              ? [{ symbol: 'A', side: 'BUY', quantity: 4 }]
              : [];
        state.step += 1;
        return { orders };
      },
    };

    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 20_000),
      dailyBar(3, 20_000),
    ];
    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    const buyFills = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buyFills).toHaveLength(2);
    expect(buyFills[1]!.quantity).toBe(20); // 발행 시점의 4 가 아니라 조정된 20
    expect(result.openPositions).toHaveLength(1);
    expect(result.openPositions[0]!.quantity).toBe(70); // 분할 후 50 + 새 매수 20
  });

  it('포지션이 없는 종목의 신규 진입 BUY 도 분할 봉에서 조정된 수량으로 체결된다', () => {
    // 봉 1 에서 처음 발행하는 BUY — 이 시점엔 A 포지션이 아예 없다.
    // 체결은 다음 봉(분할 봉인 봉 2)에서 일어난다.
    // 포지션 순회만으로는 이 종목이 걸리지 않는다 — 대기 주문도 훑어야 한다.
    const result = runBacktest(buyAtBarStrategy(1, 5) as never, {
      candles: [
        dailyBar(0, 100_000),
        dailyBar(1, 100_000),
        dailyBar(2, 20_000),
        dailyBar(3, 20_000),
      ],
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    // 5주 × 100_000 = 500_000 을 의도했다면, 분할 후 25주 × 20_000 이 같은
    // 500_000 이다 — 조정 없이 5주 그대로 체결되면 100_000 만 들어간다.
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.quantity).toBe(25); // 발행 시점의 5 가 아니라 조정된 25
    expect(result.openPositions).toHaveLength(1);
    expect(result.openPositions[0]!.quantity).toBe(25);
  });

  it('청산 후 재진입하면 청산-재진입 공백에서 일어난 분할이 새 포지션에 다시 적용되지 않는다', () => {
    // 이 테스트만 쓰는 별도 분할일 — 봉 2 와 봉 3 사이에 효력이 떨어진다.
    // 청산(봉 2 체결)과 재진입 신호(봉 3 발행) 사이의 공백을 이 분할이 지나가게 만든다.
    const GAP_SPLIT_PERIOD_KEY = '2026-07-09';

    // 봉0 발행 BUY → 봉1 체결로 P1 개설. 봉1 발행 SELL → 봉2 체결로 P1 청산.
    // 청산 이후 아무 포지션·대기 주문도 없는 공백(봉2~봉3)에 위 분할이 걸친다.
    // 봉3 발행 BUY 로 재진입 → 봉4 체결. 재진입 신호는 분할이 이미 끝난 뒤라
    // 이 새 주문은 조정 대상이 아니어야 한다.
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'close-then-reopen',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] =
          state.step === 0
            ? [{ symbol: 'A', side: 'BUY', quantity: 10 }]
            : state.step === 1
              ? [{ symbol: 'A', side: 'SELL', quantity: 10 }]
              : state.step === 3
                ? [{ symbol: 'A', side: 'BUY', quantity: 10 }]
                : [];
        state.step += 1;
        return { orders };
      },
    };

    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 100_000),
      dailyBar(3, 20_000),
      dailyBar(4, 20_000),
    ];
    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', GAP_SPLIT_PERIOD_KEY, 5)],
    });

    const buyFills = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buyFills).toHaveLength(2);
    expect(buyFills[1]!.quantity).toBe(10); // 재진입 이전에 끝난 분할 — 조정 대상이 아니다
    expect(result.openPositions).toHaveLength(1);
    expect(result.openPositions[0]!.quantity).toBe(10);
    expect(result.openPositions[0]!.avgEntryPrice).toBe(20_000);
  });

  it('봉을 한 번도 본 적 없는 종목의 첫 주문에는 그 이전 분할이 걸리지 않는다', () => {
    // 기준 시각을 발행 시점에 놓는 세 번째 자리(주문 발행 구간)를 고정한다.
    // C 는 봉 3 에 처음 등장하고, 그 이전 봉에는 아예 없다.
    // 전략은 봉 2 에서 C 매수를 발행한다 — 이때 C 의 기준 시각이 아직 없다.
    //
    // C 의 분할은 봉 0 과 봉 1 사이에 효력이 떨어진다 — 발행보다 한참 전이다.
    // 기준 시각을 놓지 않으면 기본값 -1 때문에 이 옛 분할이 첫 주문에 걸린다.
    const PAST_SPLIT_PERIOD_KEY = '2026-07-07';

    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'first-order-unseen-symbol',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] =
          state.step === 2 ? [{ symbol: 'C', side: 'BUY', quantity: 10 }] : [];
        state.step += 1;
        return { orders };
      },
    };

    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 100_000),
      dailyBar(3, 100_000),
      { ...dailyBar(3, 20_000), symbol: 'C' },
    ];
    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('C', PAST_SPLIT_PERIOD_KEY, 5)],
    });

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.symbol).toBe('C');
    expect(result.fills[0]!.quantity).toBe(10); // 발행 이전에 끝난 분할 — 조정 대상이 아니다
  });

  it('청산 뒤에도 계속 거래된 종목의 분할은 정지 중 발행한 재진입 주문에 걸리지 않는다', () => {
    // 위 '청산 후 재진입' 테스트의 정지 버전이다.
    // 재진입 주문을 A 가 정지된 봉에서 발행해, 발행 시점 기준 시각 갱신을 막는다.
    // 그러면 기준 시각은 A 가 마지막으로 봉을 가진 시각이어야 맞다.
    //
    // A 는 봉 0~3 과 봉 5 에 있고 봉 4 에는 없다(정지). B 는 봉 4 에만 둔다.
    // 분할 효력은 봉 2 와 봉 3 사이에 떨어진다.
    // 청산은 봉 2 에서 끝나고, 봉 3 은 A 가 보유도 대기 주문도 없는 상태로 지난다.
    // 봉 3 종가 20_000 은 이미 분할이 반영된 시장 가격이다.
    //
    // 봉 3 에서 기준 시각이 얼어붙으면 봉 5 에서 이 분할이 되살아난다.
    // 10주(약 200_000 의도)가 50주(1_000_000)로 부풀어 5배를 투입한다.
    const GAP_SPLIT_PERIOD_KEY = '2026-07-09';

    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'reenter-during-halt',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] =
          state.step === 0
            ? [{ symbol: 'A', side: 'BUY', quantity: 10 }]
            : state.step === 1
              ? [{ symbol: 'A', side: 'SELL', quantity: 10 }]
              : state.step === 4
                ? [{ symbol: 'A', side: 'BUY', quantity: 10 }]
                : [];
        state.step += 1;
        return { orders };
      },
    };

    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 100_000),
      dailyBar(3, 20_000),
      { ...dailyBar(4, 20_000), symbol: 'B' },
      dailyBar(5, 20_000),
    ];
    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', GAP_SPLIT_PERIOD_KEY, 5)],
    });

    const buyFills = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buyFills).toHaveLength(2);
    expect(buyFills[1]!.quantity).toBe(10); // 이미 시장 가격에 흡수된 분할 — 재적용 금지
    expect(buyFills[1]!.quantity * buyFills[1]!.price).toBe(200_000);
    expect(result.openPositions).toHaveLength(1);
    expect(result.openPositions[0]!.quantity).toBe(10);
    expect(result.openPositions[0]!.avgEntryPrice).toBe(20_000);
  });

  it('정지 중인 종목에 발행한 주문도 재개 봉에서 조정이 살아 있다', () => {
    // A 는 봉 1 에만 있고 봉 2~3 에는 없다(정지). 봉 4 에 재개한다.
    // B 는 봉 2~3 에도 있어 그 시각이 타임라인에서 사라지지 않게 한다.
    // 분할 효력은 봉 1 과 봉 2 사이에 떨어진다 — 정지 구간 초입이다.
    const candles = [
      dailyBar(1, 100_000),
      { ...dailyBar(2, 100_000), symbol: 'B' },
      { ...dailyBar(3, 100_000), symbol: 'B' },
      dailyBar(4, 20_000),
    ];

    // O1 은 봉 1(A 있음)에 발행해 커서를 봉1 시각에 심는다.
    // O2 는 봉 2(A 없음, 정지 중)에 발행한다.
    // O2 등록이 커서를 덮어쓰면 O1 의 조정 권리가 사라진다.
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'buy-during-halt',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] =
          state.step === 0 || state.step === 1
            ? [{ symbol: 'A', side: 'BUY', quantity: 10 }]
            : [];
        state.step += 1;
        return { orders };
      },
    };

    const result = runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    // 두 주문 다 봉 4(재개=분할 봉)에서 체결되고, 둘 다 조정된 수량이어야
    // 정지 구간에 발행된 주문의 조정 권리가 살아 있다고 말할 수 있다.
    const buyFills = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buyFills).toHaveLength(2);
    expect(buyFills[0]!.quantity).toBe(50); // 발행 시점의 10 이 아니라 조정된 50
    expect(buyFills[1]!.quantity).toBe(50);
    expect(result.openPositions).toHaveLength(1);
    expect(result.openPositions[0]!.quantity).toBe(100);
    expect(result.openPositions[0]!.avgEntryPrice).toBe(20_000);
  });

  it('포지션도 대기 주문도 없어도 봉이 있으면 훅을 부른다', () => {
    // 훅 호출을 기록하는 가짜 전략. 실제 스톱 조정 로직은 전략 층 테스트가 맡고,
    // 여기서는 엔진이 훅을 정확한 시점·인자로 부르는지만 본다.
    const calls: Array<{ symbol: string; ratio: number }> = [];
    const strategy = {
      id: 'hook-recorder',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({}),
      onBars: () => ({ orders: [] }),
      onCorporateAction(symbol: string, ratio: number) {
        calls.push({ symbol, ratio });
      },
    };

    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 20_000),
      dailyBar(3, 20_000),
    ];
    runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    // 이 전략은 주문을 내지 않아 포지션도 대기 주문도 없다.
    // 그래도 훅은 불러야 한다 — 전략은 보유하지 않는 종목의 지표도 계속 누적한다.
    // 보유 종목으로 좁히면 허위 **진입** 신호를 만드는 상태가 조정되지 않고 남는다.
    expect(calls).toEqual([{ symbol: 'A', ratio: 5 }]);
  });

  it('보유 중 분할에서 정확한 심볼과 합성 ratio 로 훅을 부른다', () => {
    const calls: Array<{ symbol: string; ratio: number }> = [];
    const strategy = {
      id: 'hook-recorder-2',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context: StrategyBarContext, state: { step: number }) {
        const orders: OrderIntent[] =
          state.step === 0 ? [{ symbol: 'A', side: 'BUY', quantity: 10 }] : [];
        state.step += 1;
        return { orders };
      },
      onCorporateAction(symbol: string, ratio: number) {
        calls.push({ symbol, ratio });
      },
    };

    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 20_000),
      dailyBar(3, 20_000),
    ];
    runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      facts: [splitFact('A', SPLIT_PERIOD_KEY, 5)],
    });

    expect(calls).toEqual([{ symbol: 'A', ratio: 5 }]);
  });

  it('자본변동이 없는 봉에서는 훅을 부르지 않는다', () => {
    const calls: Array<{ symbol: string; ratio: number }> = [];
    const strategy = {
      id: 'hook-recorder-3',
      version: '1.0.0',
      name: 't',
      description: 't',
      parameterSchema: z.unknown(),
      initialize: () => ({ step: 0 }),
      onBars(_context: StrategyBarContext, state: { step: number }) {
        const orders: OrderIntent[] =
          state.step === 0 ? [{ symbol: 'A', side: 'BUY', quantity: 10 }] : [];
        state.step += 1;
        return { orders };
      },
      onCorporateAction(symbol: string, ratio: number) {
        calls.push({ symbol, ratio });
      },
    };

    const candles = [dailyBar(0, 100_000), dailyBar(1, 100_000), dailyBar(2, 100_000)];
    runBacktest(strategy as never, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      // `facts` 를 아예 넘기지 않는다 — 자본변동 이력이 없다
    });

    expect(calls).toHaveLength(0);
  });
});
