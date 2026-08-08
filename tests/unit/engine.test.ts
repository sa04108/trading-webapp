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
  });

  it('분할 후 진입한 포지션은 그 분할의 영향을 받지 않는다', () => {
    const candles = [
      dailyBar(0, 100_000),
      dailyBar(1, 100_000),
      dailyBar(2, 20_000),
      dailyBar(3, 20_000),
      dailyBar(4, 20_000),
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
  });
});
