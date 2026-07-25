import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile, OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type {
  StrategyBarContext,
  TradingStrategy,
} from '../../src/server/modules/strategy/domain/strategy.js';
import {
  hourlyBreakoutStrategy,
  type HourlyBreakoutParameters,
} from '../../src/server/modules/strategy/strategies/hourly-breakout.js';

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
    timeframe: '1h',
    tsMs: START + index * HOUR,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume: 100,
    ...overrides,
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
  });

  it('is deterministic: same input and seed produce identical results (스펙 §9.5)', () => {
    const candles = Array.from({ length: 300 }, (_, i) =>
      bar(i, 100 + 10 * Math.sin(i / 7) + (i % 13)),
    );
    const parameters: HourlyBreakoutParameters = {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      riskPerTradePercent: 2,
      maxPositions: 5,
    };

    const run = () =>
      runBacktest(hourlyBreakoutStrategy as never, {
        candles,
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters,
        randomSeed: 42,
        maxPositions: parameters.maxPositions,
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

describe('hourly-breakout 갭 진입 손·익절 기준 (Codex 리뷰)', () => {
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

    const parameters: HourlyBreakoutParameters = {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      riskPerTradePercent: 2,
      maxPositions: 5,
    };

    const result = runBacktest(hourlyBreakoutStrategy as never, {
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

describe('hourly-breakout look-ahead fixture (스펙 §33)', () => {
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

    const parameters: HourlyBreakoutParameters = {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      riskPerTradePercent: 2,
      maxPositions: 5,
    };

    const result = runBacktest(hourlyBreakoutStrategy as never, {
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
