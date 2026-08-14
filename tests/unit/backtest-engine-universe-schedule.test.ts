import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile, OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { StrategyBarContext, TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

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

function member(
  symbol: string,
  metrics: {
    marketCapKrw?: string | null;
    volume?: number | null;
    tradingValueKrw?: string | null;
  } = {},
) {
  return {
    symbol,
    marketCapKrw: metrics.marketCapKrw ?? null,
    volume: metrics.volume ?? null,
    tradingValueKrw: metrics.tradingValueKrw ?? null,
  };
}

/**
 * 매 봉 A·B 모두에 1주 매수를 시도하는 전략 — 유니버스 필터가 실제로 걸러내는지
 * 보려면 전략이 스스로 필터링하지 않고 항상 두 종목 모두를 시도해야 한다.
 * 이미 보유 중인 종목은 다시 사지 않는다(중복 매수 방지, 테스트를 단순하게 유지).
 */
function alwaysBuyBothStrategy(): TradingStrategy<unknown, null> {
  return {
    id: 'test-always-buy-both',
    version: '1.0.0',
    name: 'test',
    description: 'test',
    parameterSchema: z.unknown(),
    initialize: () => null,
    onBars(context: StrategyBarContext) {
      const orders: OrderIntent[] = [];
      for (const symbol of ['A', 'B']) {
        if (!context.bars.has(symbol)) continue;
        if ((context.portfolio.positions.get(symbol)?.quantity ?? 0) > 0) continue;
        orders.push({ symbol, side: 'BUY', quantity: 1 });
      }
      return { orders };
    },
  };
}

describe('runBacktest — 멤버십 일정 기반 거래 대상 제한 (스펙 2026-08-05, §9.5)', () => {
  it('1구간에서는 일정에 포함된 A 만 매수되고 B 는 거부된다', () => {
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
    ];
    const result = runBacktest(alwaysBuyBothStrategy() as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['A'] }],
    });

    const filledSymbols = new Set(result.fills.map((f) => f.symbol));
    expect(filledSymbols).toEqual(new Set(['A']));
    expect(result.warnings.some((w) => w.includes('B'))).toBe(true);
  });

  it('리밸런스 이탈 매도를 전략 매도와 한 건으로 접고, 청산 다음 봉에 신규 편입을 매수한다', () => {
    // A 는 봉0 신호 → 봉1 체결. 봉2 에 B 유니버스가 활성화되면 엔진이 A 전량
    // REBALANCE_EXIT 를 예약한다. 전략도 같은 A 매도를 내지만 엔진 주문 한 건만 남고,
    // B 매수는 봉3 청산 뒤 대기열로 승격돼 봉4 시가에서 체결되어야 한다.
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(2, 100),
      bar(3, 100),
      bar(4, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
      bar(2, 200, { symbol: 'B' }),
      bar(3, 200, { symbol: 'B' }),
      bar(4, 200, { symbol: 'B' }),
    ];

    const rebalanceBars: number[] = [];
    const forcedExitSymbols: string[] = [];
    const buyBFrom2: TradingStrategy<unknown, { seen: number }> = {
      id: 'test-buy-b-from-2',
      version: '1.0.0',
      name: 'test',
      description: 'test',
      parameterSchema: z.unknown(),
      initialize: () => ({ seen: 0 }),
      onBars(context, state) {
        if (context.isRebalanceBar) rebalanceBars.push(context.tsMs);
        const orders: OrderIntent[] = [];
        // 봉0 에서 A 매수(1구간에서 유효), 봉2 이후 B 매수 시도(2구간 전환 후 유효)
        if (state.seen === 0) orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
        if (state.seen === 2) {
          const heldA = context.portfolio.positions.get('A')?.quantity ?? 0;
          if (heldA > 0) orders.push({ symbol: 'A', side: 'SELL', quantity: heldA });
          // 이 시점부터는 A 가 일정 밖이다 — 청산과 별개로 재매수 의도는 거부돼야 한다
          orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
          orders.push({ symbol: 'B', side: 'BUY', quantity: 1 });
        }
        state.seen += 1;
        return { orders };
      },
      onForcedExit(symbol) {
        forcedExitSymbols.push(symbol);
      },
    };

    const result = runBacktest(buyBFrom2 as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, members: [member('A')] },
        { fromTsMs: START + 2 * HOUR, members: [member('B')] },
      ],
    });

    const aFills = result.fills.filter((f) => f.symbol === 'A');
    const bFills = result.fills.filter((f) => f.symbol === 'B');
    expect(aFills.filter((f) => f.side === 'BUY')).toHaveLength(1);
    expect(aFills.filter((f) => f.side === 'SELL')).toHaveLength(1);
    expect(result.trades.find((trade) => trade.symbol === 'A')?.exitReason).toBe('REBALANCE_EXIT');
    expect(bFills.filter((f) => f.side === 'BUY')).toHaveLength(1);
    expect(bFills.find((f) => f.side === 'BUY')?.tsMs).toBe(START + 4 * HOUR);
    expect(forcedExitSymbols).toEqual(['A']);
    expect(rebalanceBars).toEqual([START, START + 2 * HOUR]);
  });

  it('D-1 전략 SELL은 D0 편출 판정 후 REBALANCE_EXIT로 교체해 체결한다', () => {
    const forced: string[] = [];
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'pending-sell-collision', version: '1', name: 'pending sell', description: 'pending sell',
      parameterSchema: z.unknown(), initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] = [];
        if (state.step === 0) orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
        if (state.step === 2) orders.push({ symbol: 'A', side: 'SELL', quantity: 1 });
        state.step += 1;
        return { orders };
      },
      onForcedExit(symbol) { forced.push(symbol); },
    };

    const result = runBacktest(strategy as never, {
      candles: [
        ...[0, 1, 2, 3, 4].map((index) => bar(index, 100)),
        ...[0, 1, 2, 3, 4].map((index) => bar(index, 200, { symbol: 'B' })),
      ],
      initialCash: 10_000, execution: ZERO_COST, parameters: {}, randomSeed: 42, maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, members: [member('A')] },
        { fromTsMs: START + 3 * HOUR, members: [member('B')] },
      ],
    });

    const sell = result.fills.find((fill) => fill.symbol === 'A' && fill.side === 'SELL');
    expect(sell?.tsMs).toBe(START + 3 * HOUR);
    expect(result.trades.find((trade) => trade.symbol === 'A')?.exitReason).toBe('REBALANCE_EXIT');
    expect(forced).toEqual(['A']);
  });

  it('D-1 pending BUY는 D0 멤버십으로 재검증해 편출은 취소하고 유효 매수는 청산 뒤로 미룬다', () => {
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'pending-buy-collision', version: '1', name: 'pending buy', description: 'pending buy',
      parameterSchema: z.unknown(), initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] = [];
        if (state.step === 0) orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
        if (state.step === 2) {
          orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
          orders.push({ symbol: 'B', side: 'BUY', quantity: 1 });
        }
        state.step += 1;
        return { orders };
      },
    };

    const result = runBacktest(strategy as never, {
      candles: [
        ...[0, 1, 2, 3, 4, 5].map((index) => bar(index, 100)),
        ...[0, 1, 2, 3, 4, 5].map((index) => bar(index, 200, { symbol: 'B' })),
      ],
      initialCash: 10_000, execution: ZERO_COST, parameters: {}, randomSeed: 42, maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, members: [member('A'), member('B')] },
        { fromTsMs: START + 3 * HOUR, members: [member('B')] },
      ],
    });

    const aBuys = result.fills.filter((fill) => fill.symbol === 'A' && fill.side === 'BUY');
    const aSell = result.fills.find((fill) => fill.symbol === 'A' && fill.side === 'SELL');
    const bBuy = result.fills.find((fill) => fill.symbol === 'B' && fill.side === 'BUY');
    expect(aBuys).toHaveLength(1);
    expect(aSell?.tsMs).toBe(START + 4 * HOUR);
    expect(bBuy?.tsMs).toBe(START + 5 * HOUR);
    expect((aSell?.tsMs ?? Infinity) < (bBuy?.tsMs ?? -Infinity)).toBe(true);
  });

  it('일정 밖 심볼의 BUY 의도는 거부되고 종목당 한 번만 warning 이 쌓인다', () => {
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(2, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
      bar(2, 200, { symbol: 'B' }),
    ];
    const result = runBacktest(alwaysBuyBothStrategy() as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['A'] }],
    });

    // B 는 매 봉마다(세 번) 매수를 시도하지만, 실제로 체결되는 것은 없고
    // 경고는 종목당 한 줄로만 쌓여야 한다(폭주 방지).
    const bFills = result.fills.filter((f) => f.symbol === 'B');
    expect(bFills).toHaveLength(0);
    const bWarnings = result.warnings.filter((w) => w.includes('B') && w.includes('멤버십 일정'));
    expect(bWarnings).toHaveLength(1);
  });

  it('일정이 미지정이면 tradableSymbols 는 null 이고 종목을 제한하지 않는다', () => {
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
    ];
    const result = runBacktest(alwaysBuyBothStrategy() as never, {
      candles,
      initialCash: 100_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      // universeSchedule 미지정
    });

    const filledSymbols = new Set(result.fills.map((f) => f.symbol));
    expect(filledSymbols).toEqual(new Set(['A', 'B']));
  });

  it('첫 리밸런스 이전 시점에도 첫 entry 를 적용한다 (방어적 단순화)', () => {
    // 일정의 첫 entry 가 봉1 부터 시작해도, 봉0(그 이전) 에서도 같은 유니버스가 적용된다.
    const candles = [
      bar(0, 100),
      bar(1, 100),
      bar(0, 200, { symbol: 'B' }),
      bar(1, 200, { symbol: 'B' }),
    ];
    const result = runBacktest(alwaysBuyBothStrategy() as never, {
      candles,
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START + HOUR, symbols: ['A'] }], // 봉1 시각부터 유효
    });

    const filledSymbols = new Set(result.fills.map((f) => f.symbol));
    expect(filledSymbols).toEqual(new Set(['A'])); // 봉0 신호도 A 만 허용됨
  });

  it('활성 멤버십과 당일 매수 가능 종목을 분리해 전략에 전달한다', () => {
    let seenAtFirstBar: ReadonlySet<string> | null | undefined;
    let activeAtFirstBar: ReadonlySet<string> | null | undefined;
    const spy: TradingStrategy<unknown, null> = {
      id: 'spy-tradable',
      version: '1.0.0',
      name: 'spy',
      description: 'spy',
      parameterSchema: z.unknown(),
      initialize: () => null,
      onBars(context: StrategyBarContext) {
        if (seenAtFirstBar === undefined) {
          seenAtFirstBar = context.tradableSymbols;
          activeAtFirstBar = context.activeUniverseSymbols;
        }
        return { orders: [] };
      },
    };

    runBacktest(spy as never, {
      candles: [
        bar(0, 100),
        bar(1, 100),
        bar(0, 200, { symbol: 'B' }),
        bar(1, 200, { symbol: 'B' }),
      ],
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['A', 'B'] }],
      nonTradingSymbolsByTsMs: new Map([[START, new Set(['B'])]]),
    });

    expect(seenAtFirstBar).toBeInstanceOf(Set);
    expect([...(seenAtFirstBar as ReadonlySet<string>)]).toEqual(['A']);
    expect(activeAtFirstBar).toBeInstanceOf(Set);
    expect([...(activeAtFirstBar as ReadonlySet<string>)]).toEqual(['A', 'B']);
  });

  it('warm-up은 PIT·자본변동·history·전략 state만 갱신하고 주문·자산곡선·진행률을 남기지 않는다', () => {
    const day = 86_400_000;
    const times = [START, START + day, START + 2 * day, START + 3 * day];
    const seen: Array<{
      tsMs: number;
      history: number;
      netIncome: number | null;
      isRebalanceBar: boolean;
    }> = [];
    const corporateActionRatios: number[] = [];
    const progress: Array<{ processedBars: number; totalBars: number; currentTsMs: number }> = [];
    const facts: Fact[] = [
      {
        scope: 'SYMBOL', key: 'A', field: 'NET_INCOME', periodKey: '2026Q1',
        asOfTsMs: times[1]!, value: 123, unit: 'KRW',
      },
      {
        scope: 'SYMBOL', key: 'A', field: CORPORATE_ACTION_FIELD,
        periodKey: '2026-07-07', asOfTsMs: times[3]!, value: 2, unit: 'ratio',
      },
    ];
    const strategy: TradingStrategy<unknown, { calls: number }> = {
      id: 'warmup-observer', version: '1', name: 'warmup', description: 'warmup',
      parameterSchema: z.unknown(),
      initialize: () => ({ calls: 0 }),
      onBars(context, state) {
        state.calls += 1;
        seen.push({
          tsMs: context.tsMs,
          history: context.getHistory('A').length,
          netIncome: context.fundamentals('A')?.get('NET_INCOME') ?? null,
          isRebalanceBar: context.isRebalanceBar,
        });
        // warm-up 결정을 엔진이 대기열에 넣는 회귀를 잡는다.
        return state.calls <= 2
          ? { orders: [{ symbol: 'A', side: 'BUY', quantity: 1 }] }
          : { orders: [] };
      },
      onCorporateAction(_symbol, ratio) {
        corporateActionRatios.push(ratio);
      },
    };

    const result = runBacktest(strategy as never, {
      candles: times.map((tsMs, index) => bar(index, index < 2 ? 50 : 100, { tsMs })),
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: {}, randomSeed: 42, maxPositions: 5,
      facts,
      tradeFromTsMs: times[2],
    }, {
      onProgress(item) { progress.push(item); },
    });

    expect(seen.map((item) => item.history)).toEqual([1, 2, 3, 4]);
    expect(seen.map((item) => item.netIncome)).toEqual([null, 123, 123, 123]);
    expect(seen.filter((item) => item.isRebalanceBar).map((item) => item.tsMs)).toEqual([times[2]]);
    expect(corporateActionRatios).toEqual([2]);
    expect(result.fills).toEqual([]);
    expect(result.trades).toEqual([]);
    expect(result.equityPoints.map((point) => point.tsMs)).toEqual([times[2], times[3]]);
    expect(result.processedBars).toBe(2);
    expect(progress).toEqual([{ processedBars: 2, totalBars: 2, currentTsMs: times[3] }]);
  });

  it('휴일 기준 schedule entry는 다음 실제 봉에서 한 번만 활성화된다', () => {
    const seen: Array<{ tsMs: number; isRebalanceBar: boolean }> = [];
    const strategy: TradingStrategy<unknown, null> = {
      id: 'holiday-activation', version: '1', name: 'holiday', description: 'holiday',
      parameterSchema: z.unknown(), initialize: () => null,
      onBars(context) {
        seen.push({ tsMs: context.tsMs, isRebalanceBar: context.isRebalanceBar });
        return { orders: [] };
      },
    };
    runBacktest(strategy as never, {
      candles: [bar(0, 100), bar(1, 100), bar(3, 100), bar(4, 100)],
      initialCash: 10_000, execution: ZERO_COST, parameters: {}, randomSeed: 42, maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, members: [member('A')] },
        { fromTsMs: START + 2 * HOUR, members: [member('A')] },
      ],
    });
    expect(seen.filter((item) => item.isRebalanceBar).map((item) => item.tsMs)).toEqual([
      START,
      START + 3 * HOUR,
    ]);
  });

  it('활성 schedule member의 pin된 선정 지표만 context에서 반환한다', () => {
    const seen: unknown[] = [];
    const strategy: TradingStrategy<unknown, null> = {
      id: 'pinned-metrics', version: '1', name: 'metrics', description: 'metrics',
      parameterSchema: z.unknown(), initialize: () => null,
      onBars(context) {
        seen.push({
          a: context.selectionMetric('A'),
          b: context.selectionMetric('B'),
          missing: context.selectionMetric('C'),
        });
        return { orders: [] };
      },
    };
    runBacktest(strategy as never, {
      candles: [bar(0, 100), bar(1, 100), bar(2, 100)],
      initialCash: 10_000, execution: ZERO_COST, parameters: {}, randomSeed: 42, maxPositions: 5,
      universeSchedule: [
        {
          fromTsMs: START,
          members: [member('A', { marketCapKrw: '9007199254740993', volume: 11, tradingValueKrw: '101' })],
        },
        {
          fromTsMs: START + HOUR,
          members: [member('B', { marketCapKrw: '202', volume: 22, tradingValueKrw: '303' })],
        },
      ],
    });
    expect(seen).toEqual([
      {
        a: { marketCapKrw: '9007199254740993', volume: 11, tradingValueKrw: '101' },
        b: null,
        missing: null,
      },
      {
        a: null,
        b: { marketCapKrw: '202', volume: 22, tradingValueKrw: '303' },
        missing: null,
      },
      {
        a: null,
        b: { marketCapKrw: '202', volume: 22, tradingValueKrw: '303' },
        missing: null,
      },
    ]);
  });

  it('같은 membership의 다음 entry는 리밸런스 신호만 내고 보유분을 청산하지 않는다', () => {
    const forced: string[] = [];
    const strategy = buyAtFirstBarAndObserveForcedExit(forced);
    const result = runBacktest(strategy as never, {
      candles: [bar(0, 100), bar(1, 100), bar(2, 100), bar(3, 100)],
      initialCash: 10_000, execution: ZERO_COST, parameters: {}, randomSeed: 42, maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, members: [member('A')] },
        { fromTsMs: START + 2 * HOUR, members: [member('A')] },
      ],
    });
    expect(result.fills.filter((fill) => fill.side === 'SELL')).toEqual([]);
    expect(result.trades).toEqual([]);
    expect(forced).toEqual([]);
  });

  it('이탈 종목의 다음 거래 가능 봉이 끝까지 없으면 신규 매수를 실행하지 않고 경고한다', () => {
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'unfilled-exit', version: '1', name: 'unfilled', description: 'unfilled',
      parameterSchema: z.unknown(), initialize: () => ({ step: 0 }),
      onBars(context, state) {
        const orders: OrderIntent[] = [];
        if (state.step === 0) orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
        if (context.isRebalanceBar && state.step > 0) {
          orders.push({ symbol: 'B', side: 'BUY', quantity: 1 });
        }
        state.step += 1;
        return { orders };
      },
    };
    const result = runBacktest(strategy as never, {
      candles: [
        bar(0, 100), bar(1, 100),
        bar(0, 200, { symbol: 'B' }), bar(1, 200, { symbol: 'B' }),
        bar(2, 200, { symbol: 'B' }), bar(3, 200, { symbol: 'B' }), bar(4, 200, { symbol: 'B' }),
      ],
      initialCash: 10_000, execution: ZERO_COST, parameters: {}, randomSeed: 42, maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, members: [member('A')] },
        { fromTsMs: START + 2 * HOUR, members: [member('B')] },
      ],
    });
    expect(result.fills.some((fill) => fill.symbol === 'B' && fill.side === 'BUY')).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('리밸런스') && warning.includes('체결'))).toBe(true);
  });

  it('지연된 REBALANCE_EXIT 체결 전 재편입되면 청산을 취소하고 deferred BUY를 해제한다', () => {
    const forced: string[] = [];
    const strategy: TradingStrategy<unknown, { step: number }> = {
      id: 'reentry-before-exit-fill', version: '1', name: 'reentry', description: 'reentry',
      parameterSchema: z.unknown(), initialize: () => ({ step: 0 }),
      onBars(_context, state) {
        const orders: OrderIntent[] = [];
        if (state.step === 0) orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
        if (state.step === 2) orders.push({ symbol: 'B', side: 'BUY', quantity: 1 });
        state.step += 1;
        return { orders };
      },
      onForcedExit(symbol) { forced.push(symbol); },
    };

    const result = runBacktest(strategy as never, {
      candles: [
        ...[0, 1, 2, 3, 4].map((index) => bar(index, 100)),
        ...[0, 1, 2, 3, 4].map((index) => bar(index, 200, { symbol: 'B' })),
      ],
      initialCash: 10_000, execution: ZERO_COST, parameters: {}, randomSeed: 42, maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, members: [member('A')] },
        { fromTsMs: START + 2 * HOUR, members: [member('B')] },
        { fromTsMs: START + 3 * HOUR, members: [member('A'), member('B')] },
      ],
    });

    expect(result.fills.filter((fill) => fill.symbol === 'A' && fill.side === 'SELL')).toEqual([]);
    expect(result.openPositions.find((position) => position.symbol === 'A')?.quantity).toBe(1);
    expect(result.fills.find((fill) => fill.symbol === 'B' && fill.side === 'BUY')?.tsMs)
      .toBe(START + 4 * HOUR);
    expect(forced).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('리밸런스 유니버스 이탈 청산')))
      .toBe(false);
  });

  it('지연된 이탈 청산 체결 봉에서 전략이 같은 BUY를 다시 내도 다음 open에 한 건만 체결한다', () => {
    const strategy: TradingStrategy<unknown, { step: number; rebalanceSeen: boolean }> = {
      id: 'repeat-deferred-buy', version: '1', name: 'repeat', description: 'repeat',
      parameterSchema: z.unknown(), initialize: () => ({ step: 0, rebalanceSeen: false }),
      onBars(context, state) {
        const orders: OrderIntent[] = [];
        if (state.step === 0) orders.push({ symbol: 'A', side: 'BUY', quantity: 1 });
        if (context.isRebalanceBar && state.step > 0) state.rebalanceSeen = true;
        if (state.rebalanceSeen && !context.portfolio.positions.has('B')) {
          orders.push({ symbol: 'B', side: 'BUY', quantity: 1 });
        }
        state.step += 1;
        return { orders };
      },
    };
    const result = runBacktest(strategy as never, {
      candles: [
        // A는 D2 리밸런스 뒤 D3 봉이 없어 청산이 D4까지 지연된다.
        bar(0, 100), bar(1, 100), bar(2, 100), bar(4, 100), bar(5, 100),
        bar(0, 200, { symbol: 'B' }), bar(1, 200, { symbol: 'B' }),
        bar(2, 200, { symbol: 'B' }), bar(3, 200, { symbol: 'B' }),
        bar(4, 200, { symbol: 'B' }), bar(5, 200, { symbol: 'B' }),
      ],
      initialCash: 10_000, execution: ZERO_COST, parameters: {}, randomSeed: 42, maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, members: [member('A')] },
        { fromTsMs: START + 2 * HOUR, members: [member('B')] },
      ],
    });

    const bBuys = result.fills.filter((fill) => fill.symbol === 'B' && fill.side === 'BUY');
    expect(bBuys).toHaveLength(1);
    expect(bBuys[0]?.tsMs).toBe(START + 5 * HOUR);
  });

  it('schedule이 없으면 warm-up 뒤 첫 거래 봉만 isRebalanceBar=true다', () => {
    const seen: Array<{ tsMs: number; isRebalanceBar: boolean; tradable: ReadonlySet<string> | null }> = [];
    const strategy: TradingStrategy<unknown, null> = {
      id: 'no-schedule', version: '1', name: 'no schedule', description: 'no schedule',
      parameterSchema: z.unknown(), initialize: () => null,
      onBars(context) {
        seen.push({ tsMs: context.tsMs, isRebalanceBar: context.isRebalanceBar, tradable: context.tradableSymbols });
        return { orders: [] };
      },
    };
    runBacktest(strategy as never, {
      candles: [bar(0, 100), bar(1, 100), bar(2, 100)],
      initialCash: 10_000, execution: ZERO_COST, parameters: {}, randomSeed: 42, maxPositions: 5,
      tradeFromTsMs: START + HOUR,
    });
    expect(seen.map((item) => item.isRebalanceBar)).toEqual([false, true, false]);
    expect(seen.every((item) => item.tradable === null)).toBe(true);
  });
});

function buyAtFirstBarAndObserveForcedExit(
  forced: string[],
): TradingStrategy<unknown, { fired: boolean }> {
  return {
    id: 'buy-and-observe', version: '1', name: 'buy', description: 'buy',
    parameterSchema: z.unknown(), initialize: () => ({ fired: false }),
    onBars(_context, state) {
      if (state.fired) return { orders: [] };
      state.fired = true;
      return { orders: [{ symbol: 'A', side: 'BUY', quantity: 1 }] };
    },
    onForcedExit(symbol) { forced.push(symbol); },
  };
}
