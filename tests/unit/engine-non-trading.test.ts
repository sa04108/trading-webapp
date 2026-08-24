import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 4, 12);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function bar(symbol: string, index: number, close = 1_000): Candle {
  return {
    symbol, market: 'KR', timeframe: '1d', tsMs: START + index * DAY,
    open: close, high: close + 10, low: close - 10, close, volume: 100,
  };
}

/** 첫 봉에서 대상 종목을 한 번 매수하려 드는 전략 */
function buyOnceStrategy(target: string): TradingStrategy<unknown, { done: boolean }> {
  return {
    id: 'buy-once', version: '1', name: 'buy once', description: '',
    parameterSchema: z.object({}).passthrough(),
    initialize: () => ({ done: false }),
    onBars: (_context, state) => {
      if (state.done) return { orders: [] };
      state.done = true;
      return { orders: [{ symbol: target, side: 'BUY' as const, quantity: 1 }] };
    },
  };
}

/** 매 봉마다 대상 종목을 매수하려 드는 전략 — 거래불가 필터가 다음 봉으로 새는지 검증하는 용도 */
function buyEveryBarStrategy(target: string): TradingStrategy<unknown, null> {
  return {
    id: 'buy-every-bar', version: '1', name: 'buy every bar', description: '',
    parameterSchema: z.object({}).passthrough(),
    initialize: () => null,
    onBars: () => ({ orders: [{ symbol: target, side: 'BUY' as const, quantity: 1 }] }),
  };
}

function buyAtTsStrategy(
  ordersAtTs: ReadonlyMap<number, readonly string[]>,
): TradingStrategy<unknown, null> {
  return {
    id: 'buy-at-ts', version: '1', name: 'buy at timestamp', description: '',
    parameterSchema: z.object({}).passthrough(),
    initialize: () => null,
    onBars: (context) => ({
      orders: (ordersAtTs.get(context.tsMs) ?? []).map((symbol) => ({
        symbol,
        side: 'BUY' as const,
        quantity: 1,
      })),
    }),
  };
}

describe('엔진 거래불가일', () => {
  it('거래불가 종목의 매수를 거부한다', () => {
    const candles = [bar('A', 0), bar('A', 1), bar('B', 0), bar('B', 1)];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      // 0번 봉 시점에 A 가 거래불가다 — 주문은 그 시점에 발행되고 검증에서 걸려야 한다
      nonTradingSymbolsByTsMs: new Map([[START, new Set(['A'])]]),
    });

    expect(result.fills).toHaveLength(0);
    const text = result.warnings.join('\n');
    // 사유를 정지로 밝힌다. 멤버십 일정 안전망 문구로 새면 사용자는 멀쩡한 전략을
    // 버그로 읽는다 — 접두사만 보는 단언으로는 그 회귀를 잡지 못한다.
    expect(text).toContain('A 매수 거부: 그날 거래정지·무거래로 매수할 수 없는 종목입니다.');
    expect(text).not.toContain('전략 버그 안전망');
  });

  it('거래정지 거부와 유니버스 위반 거부는 서로의 경고를 가리지 않는다', () => {
    // 같은 종목이 0번 봉에서는 정지로, 2번 봉에서는 유니버스 밖이라 거부된다.
    // 한 집합으로 중복을 지우면 뒤에 난 진짜 유니버스 위반이 조용히 사라진다.
    const candles = [bar('A', 0), bar('A', 1), bar('A', 2), bar('B', 0), bar('B', 1), bar('B', 2)];
    const result = runBacktest(buyEveryBarStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      nonTradingSymbolsByTsMs: new Map([[START, new Set(['A'])]]),
      // 0~1번 봉은 A 가 유니버스 안, 2번 봉부터는 B 만 남는다
      universeSchedule: [
        { fromTsMs: START, symbols: ['A', 'B'] },
        { fromTsMs: START + 2 * DAY, symbols: ['B'] },
      ],
    });

    const text = result.warnings.join('\n');
    expect(text).toContain('A 매수 거부: 그날 거래정지·무거래로 매수할 수 없는 종목입니다.');
    expect(text).toContain('A 매수 거부: 활성 멤버십 일정에 포함되지 않은 종목입니다 (전략 버그 안전망).');
  });

  it('거래불가 종목이 없으면 그대로 매수한다', () => {
    const candles = [bar('A', 0), bar('A', 1)];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(result.fills).toHaveLength(1);
  });

  it('거래불가는 그 봉에만 걸리고 다음 봉으로 새지 않는다', () => {
    // 멤버십 일정이 없는 경로(제한 없음 = null)에서만 새는 버그가 난다.
    // 0번 봉에서만 A 를 거래불가로 두고, 1번 봉 주문까지 막히면 필터가 샌 것이다.
    const candles = [bar('A', 0), bar('A', 1), bar('A', 2)];
    const result = runBacktest(buyEveryBarStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      nonTradingSymbolsByTsMs: new Map([[START, new Set(['A'])]]),
    });

    // 0번 봉 주문은 거부된다. 1번 봉 주문은 막히지 않아 2번 봉 시가에서 체결된다.
    // tsMs 를 못박아, 필터가 새서 0번 봉 주문이 (1번 봉 시가에) 체결된 경우와 구별한다.
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.tsMs).toBe(START + 2 * DAY);
  });
});

describe('상장폐지 청산', () => {
  it('마지막 거래 가능 봉 종가를 사용하되 폐지 효력 시각에 청산한다', () => {
    // A 는 2번 봉이 마지막이고 그 뒤 폐지된다. B 는 끝까지 산다.
    // 2번 봉은 시가(600)와 종가(500)를 일부러 다르게 둔다 — bar() 헬퍼의 기본값(open ===
    // close)을 그대로 쓰면 청산가가 시가로 퇴행해도 값이 우연히 같아 테스트가 못 잡는다.
    // high/low 는 시가·종가를 모두 포함하도록 맞춘다.
    const candles = [
      bar('A', 0, 1_000), bar('A', 1, 900),
      { ...bar('A', 2, 500), open: 600, high: 610 },
      bar('B', 0), bar('B', 1), bar('B', 2), bar('B', 3),
    ];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
    });

    const trade = result.trades.find((candidate) => candidate.symbol === 'A');
    expect(trade).toBeDefined();
    expect(trade?.exitReason).toBe('DELISTED');
    // 2번 봉 종가 500 으로 나간다 — 시가(600)가 아니다
    expect(trade?.exitPrice).toBe(500);
    expect(trade?.exitPrice).not.toBe(600);
    // 가격 기준일과 현금 해제일은 다르다. 마지막 거래일에 미리 청산하면 장기 정지
    // 구간에 그 현금을 재투자해 수익이 부풀려진다.
    expect(trade?.exitTsMs).toBe(START + 3 * DAY);
    expect(result.delistingLiquidations).toHaveLength(1);
    // 청산했으니 미청산으로 남지 않는다
    expect(result.openPositions.some((position) => position.symbol === 'A')).toBe(false);
  });

  it('폐지 뒤 같은 코드의 봉이 있어도 효력 시각에 직전 봉 종가로 청산한다', () => {
    // KRX 는 폐지된 단축코드를 나중에 다른 회사에 다시 준다. 그 봉까지 같은 심볼로
    // 들어오면 "실행 전체의 마지막 봉" 을 청산 시점으로 잡는 구현은 몇 년 뒤 남의
    // 회사 종가로 판다.
    const candles = [
      bar('A', 0, 1_000), bar('A', 1, 900),
      { ...bar('A', 2, 500), open: 600, high: 610 },
      bar('A', 3, 9_000), bar('A', 4, 9_500), // 같은 코드를 재사용한 다른 회사의 봉
      bar('B', 0), bar('B', 4),
    ];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
    });

    const trade = result.trades.find((candidate) => candidate.symbol === 'A');
    expect(trade?.exitReason).toBe('DELISTED');
    expect(trade?.exitTsMs).toBe(START + 3 * DAY);
    expect(trade?.exitPrice).toBe(500);
    expect(result.delistingLiquidations).toEqual([
      { symbol: 'A', tsMs: START + 3 * DAY, netPnl: trade?.netPnl },
    ]);
  });

  it('폐지 전 주문은 마지막 봉 시가에 체결하되 효력 시각까지 현금을 잠근다', () => {
    const lastOldBar = {
      ...bar('A', 1, 500),
      open: 800,
      high: 810,
      low: 490,
    };
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0, 1_000), lastOldBar, bar('A', 4, 9_000), bar('B', 0), bar('B', 4)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', [START + 2 * DAY]]]),
    });

    expect(result.fills.filter((fill) => fill.symbol === 'A')).toMatchObject([
      { side: 'BUY', tsMs: START + DAY, price: 800 },
      { side: 'SELL', tsMs: START + 2 * DAY, price: 500, reason: 'DELISTED' },
    ]);
    expect(result.trades).toMatchObject([
      { symbol: 'A', exitTsMs: START + 2 * DAY, exitReason: 'DELISTED' },
    ]);
    expect(result.metrics.maxConcurrentPositions).toBe(1);
  });

  it('장기 거래정지 뒤 폐지돼도 마지막 거래일에 청산 현금을 미리 재사용하지 않는다', () => {
    const strategy: TradingStrategy<unknown, null> = {
      id: 'buy-after-suspension', version: '1', name: 'buy after suspension', description: '',
      parameterSchema: z.object({}).passthrough(),
      initialize: () => null,
      onBars: (context) => ({
        orders: context.tsMs === START
          ? [{ symbol: 'A', side: 'BUY' as const, quantity: 1 }]
          : context.tsMs >= START + 2 * DAY && !context.portfolio.positions.has('B')
            ? [{ symbol: 'B', side: 'BUY' as const, quantity: 1 }]
            : [],
      }),
    };
    const lastOldBar = {
      ...bar('A', 1, 500),
      open: 1_000,
      high: 1_010,
    };
    const result = runBacktest(strategy, {
      candles: [
        bar('A', 0, 1_000), lastOldBar,
        ...[0, 1, 2, 3, 4, 5].map((index) => bar('B', index, 100)),
      ],
      initialCash: 1_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 2,
      delistedTsMsBySymbol: new Map([['A', [START + 5 * DAY]]]),
    });

    expect(result.fills.filter((fill) => fill.symbol === 'A')).toMatchObject([
      { side: 'BUY', tsMs: START + DAY, price: 1_000 },
      { side: 'SELL', tsMs: START + 5 * DAY, price: 500, reason: 'DELISTED' },
    ]);
    expect(result.fills.filter((fill) => fill.symbol === 'B')).toMatchObject([
      { side: 'BUY', tsMs: START + 5 * DAY, price: 100 },
    ]);
  });

  it('유효 봉이 없는 폐지 효력일에도 보유분을 그날 마지막 종가로 정산한다', () => {
    const forcedExitSymbols: string[] = [];
    const strategy: TradingStrategy<unknown, null> = {
      ...buyAtTsStrategy(new Map([
        [START, ['A']],
        [START + 2 * DAY, ['B']],
      ])),
      onForcedExit: (symbol) => { forcedExitSymbols.push(symbol); },
    };
    const lastOldBar = {
      ...bar('A', 1, 500),
      open: 800,
      high: 810,
    };
    const result = runBacktest(strategy, {
      candles: [
        bar('A', 0, 800), lastOldBar,
        ...[0, 1, 2, 4].map((index) => bar('B', index, 100)),
      ],
      initialCash: 800,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 2,
      delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
    });

    expect(result.fills).toMatchObject([
      { symbol: 'A', side: 'BUY', tsMs: START + DAY, price: 800 },
      { symbol: 'A', side: 'SELL', tsMs: START + 3 * DAY, price: 500, reason: 'DELISTED' },
      { symbol: 'B', side: 'BUY', tsMs: START + 4 * DAY, price: 100 },
    ]);
    expect(result.equityPoints.find((point) => point.tsMs === START + 3 * DAY)).toEqual({
      tsMs: START + 3 * DAY,
      equity: 500,
    });
    expect(forcedExitSymbols).toEqual(['A']);
  });

  it('폐지 마지막 봉의 리밸런스 BUY를 새 발행사의 첫 봉으로 넘기지 않는다', () => {
    const result = runBacktest(
      buyAtTsStrategy(new Map([[START + DAY, ['A']]])),
      {
        candles: [
          bar('A', 0), bar('A', 1, 500), bar('A', 4, 9_000),
          bar('B', 0), bar('B', 1), bar('B', 4),
        ],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 1,
        maxPositions: 5,
        universeSchedule: [{ fromTsMs: START + DAY, symbols: ['A'] }],
        delistedTsMsBySymbol: new Map([['A', [START + 2 * DAY]]]),
      },
    );

    expect(result.fills.filter((fill) => fill.symbol === 'A')).toHaveLength(0);
    expect(result.openPositions.some((position) => position.symbol === 'A')).toBe(false);
    expect(result.warnings.join('\n')).toContain(
      'A 주문 거부/폐기: 상장폐지 경계를 넘어 재사용된 단축코드의 후속 봉에 체결할 수 없습니다.',
    );
  });

  it('폐지될 deferred BUY를 먼저 버려 정상 BUY의 포지션 슬롯을 보존한다', () => {
    const result = runBacktest(
      buyAtTsStrategy(new Map([
        [START, ['C']],
        [START + 3 * DAY, ['A', 'B']],
      ])),
      {
        candles: [
          ...[0, 1, 2, 3, 4].map((index) => bar('C', index, 1_000)),
          ...[0, 1, 2, 3].map((index) => bar('A', index, 500)),
          bar('A', 5, 9_000),
          ...[0, 1, 2, 3, 4, 5].map((index) => bar('B', index, 700)),
        ],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 1,
        maxPositions: 1,
        universeSchedule: [
          { fromTsMs: START, symbols: ['C'] },
          { fromTsMs: START + 3 * DAY, symbols: ['A', 'B'] },
        ],
        delistedTsMsBySymbol: new Map([['A', [START + 4 * DAY]]]),
      },
    );

    expect(result.fills.filter((fill) => fill.symbol === 'C')).toMatchObject([
      { side: 'BUY', tsMs: START + DAY },
      { side: 'SELL', tsMs: START + 4 * DAY, reason: 'REBALANCE_EXIT' },
    ]);
    expect(result.fills.some((fill) => fill.symbol === 'A')).toBe(false);
    expect(result.fills.filter((fill) => fill.symbol === 'B')).toMatchObject([
      { side: 'BUY', tsMs: START + 5 * DAY },
    ]);
    expect(result.warnings.join('\n')).toContain('A 주문 거부/폐기: 상장폐지 경계를 넘어');
    expect(result.warnings.join('\n')).not.toContain('동시 보유 종목 상한');
  });

  it('리밸런스 이탈 대기 중 폐지되면 효력일 정산 뒤 대체 BUY를 그날 시가에 체결한다', () => {
    const forcedExitSymbols: string[] = [];
    const strategy: TradingStrategy<unknown, null> = {
      ...buyAtTsStrategy(new Map([
        [START, ['A']],
        [START + 2 * DAY, ['B']],
      ])),
      onForcedExit: (symbol) => { forcedExitSymbols.push(symbol); },
    };
    const result = runBacktest(strategy, {
      candles: [
        bar('A', 0, 1_000), bar('A', 1, 900), bar('A', 2, 500),
        ...[0, 1, 2, 3].map((index) => bar('B', index, 700)),
      ],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 1,
      universeSchedule: [
        { fromTsMs: START, symbols: ['A'] },
        { fromTsMs: START + 2 * DAY, symbols: ['B'] },
      ],
      delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
    });

    expect(result.fills).toMatchObject([
      { symbol: 'A', side: 'BUY', tsMs: START + DAY },
      { symbol: 'A', side: 'SELL', tsMs: START + 3 * DAY, reason: 'DELISTED' },
      { symbol: 'B', side: 'BUY', tsMs: START + 3 * DAY },
    ]);
    expect(forcedExitSymbols).toEqual(['A']);
    expect(result.fills.some((fill) => fill.reason === 'REBALANCE_EXIT')).toBe(false);
    expect(result.warnings.join('\n')).not.toContain('기간 종료까지 체결되지 않아');
    expect(result.warnings.join('\n')).not.toContain('동시 보유 종목 상한');
  });

  it('폐지 효력일에 대체 종목이 거래정지여도 deferred BUY를 재개일까지 보존한다', () => {
    const result = runBacktest(
      buyAtTsStrategy(new Map([
        [START, ['A']],
        [START + 2 * DAY, ['B']],
      ])),
      {
        candles: [
          ...[0, 1, 2].map((index) => bar('A', index, 500)),
          ...[0, 1, 2, 4].map((index) => bar('B', index, 700)),
          ...[0, 1, 2, 3, 4].map((index) => bar('C', index, 900)),
        ],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 1,
        maxPositions: 1,
        universeSchedule: [
          { fromTsMs: START, symbols: ['A'] },
          { fromTsMs: START + 2 * DAY, symbols: ['B', 'C'] },
        ],
        nonTradingSymbolsByTsMs: new Map([
          [START + 3 * DAY, new Set(['B'])],
        ]),
        delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
      },
    );

    expect(result.fills).toMatchObject([
      { symbol: 'A', side: 'BUY', tsMs: START + DAY },
      { symbol: 'A', side: 'SELL', tsMs: START + 3 * DAY, reason: 'DELISTED' },
      { symbol: 'B', side: 'BUY', tsMs: START + 4 * DAY },
    ]);
    expect(result.warnings.join('\n')).not.toContain('B 매수 거부: 그날 거래정지');
    expect(result.warnings.join('\n')).not.toContain('B 매수 거부: 활성 멤버십');
  });

  it('봉 없는 unrelated 폐지 이벤트가 강제청산 시도와 대체 BUY를 한 봉 앞당기지 않는다', () => {
    const result = runBacktest(
      buyAtTsStrategy(new Map([
        [START, ['C']],
        [START + 2 * DAY, ['B']],
      ])),
      {
        candles: [
          ...[0, 1, 2, 4].map((index) => bar('C', index, 1_000)),
          ...[0, 1, 2, 4, 5].map((index) => bar('B', index, 700)),
        ],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 1,
        maxPositions: 1,
        universeSchedule: [
          { fromTsMs: START, symbols: ['C'] },
          { fromTsMs: START + 2 * DAY, symbols: ['B'] },
        ],
        delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
      },
    );

    expect(result.fills).toMatchObject([
      { symbol: 'C', side: 'BUY', tsMs: START + DAY },
      { symbol: 'C', side: 'SELL', tsMs: START + 4 * DAY, reason: 'REBALANCE_EXIT' },
      { symbol: 'B', side: 'BUY', tsMs: START + 5 * DAY },
    ]);
  });

  it('봉 없는 효력일에는 다음 schedule을 적용하기 전 deferred BUY를 승격하지 않는다', () => {
    const result = runBacktest(
      buyAtTsStrategy(new Map([
        [START, ['A']],
        [START + 2 * DAY, ['X', 'B']],
      ])),
      {
        candles: [
          ...[0, 1, 2].map((index) => bar('A', index, 500)),
          ...[0, 1, 2, 4].map((index) => bar('B', index, 700)),
          ...[0, 1, 2, 4].map((index) => bar('X', index, 900)),
        ],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 2,
        maxPositions: 1,
        universeSchedule: [
          { fromTsMs: START, symbols: ['A', 'B', 'X'] },
          { fromTsMs: START + 2 * DAY, symbols: ['B', 'X'] },
          { fromTsMs: START + 3 * DAY, symbols: ['B'] },
        ],
        delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
      },
    );

    expect(result.fills.some((fill) => fill.symbol === 'X')).toBe(false);
    expect(result.fills.filter((fill) => fill.symbol === 'B')).toMatchObject([
      { side: 'BUY', tsMs: START + 4 * DAY },
    ]);
    expect(result.warnings.join('\n')).not.toContain('동시 보유 종목 상한');
  });

  it('폐지 청산 뒤 승격한 BUY를 같은 리밸런스 봉의 최신 주문 한 건으로 교체한다', () => {
    const strategy: TradingStrategy<unknown, null> = {
      id: 'replace-promoted-buy', version: '1', name: 'replace promoted buy', description: '',
      parameterSchema: z.object({}).passthrough(),
      initialize: () => null,
      onBars: (context) => ({
        orders: context.tsMs === START
          ? [{ symbol: 'A', side: 'BUY' as const, quantity: 1 }]
          : context.tsMs === START + DAY
            ? [{ symbol: 'B', side: 'BUY' as const, quantity: 1 }]
            : context.tsMs === START + 2 * DAY
              ? [{ symbol: 'B', side: 'BUY' as const, quantity: 2 }]
              : [],
      }),
    };
    const result = runBacktest(strategy, {
      candles: [
        bar('A', 0), bar('A', 1), bar('A', 2, 500),
        bar('B', 1, 700), bar('B', 3, 750),
        bar('C', 2), bar('C', 3),
      ],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 2,
      universeSchedule: [
        { fromTsMs: START, symbols: ['A', 'B'] },
        { fromTsMs: START + 2 * DAY, symbols: ['B', 'C'] },
      ],
      delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
    });

    const bBuys = result.fills.filter((fill) => fill.symbol === 'B' && fill.side === 'BUY');
    expect(bBuys).toMatchObject([
      { tsMs: START + 3 * DAY, quantity: 2, price: 750 },
    ]);
  });

  it('폐지 당시 포지션이 없어도 재사용된 단축코드의 후속 BUY를 거부한다', () => {
    const result = runBacktest(
      buyAtTsStrategy(new Map([[START + 4 * DAY, ['A']]])),
      {
        candles: [
          bar('A', 0), bar('A', 1, 500), bar('A', 4, 9_000), bar('A', 5, 9_500),
          bar('B', 4), bar('B', 5),
        ],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 1,
        maxPositions: 5,
        delistedTsMsBySymbol: new Map([['A', [START + 2 * DAY]]]),
      },
    );

    expect(result.fills).toHaveLength(0);
    expect(result.warnings.join('\n')).toContain('A 주문 거부/폐기: 상장폐지 경계를 넘어');
  });

  it('한 종목의 폐지 경계가 다른 종목의 다음 봉 체결을 막지 않는다', () => {
    const result = runBacktest(
      buyAtTsStrategy(new Map([[START + DAY, ['A', 'B']]])),
      {
        candles: [
          bar('A', 0), bar('A', 1, 500), bar('A', 4, 9_000),
          bar('B', 0), bar('B', 1, 1_000), bar('B', 2, 1_100),
        ],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 1,
        maxPositions: 5,
        delistedTsMsBySymbol: new Map([['A', [START + 2 * DAY]]]),
      },
    );

    expect(result.fills).toMatchObject([
      { symbol: 'B', side: 'BUY', tsMs: START + 2 * DAY, price: 1_100 },
    ]);
  });

  it.each([
    ['일정 없음', undefined],
    ['명시 일정', [{ fromTsMs: START, symbols: ['B'] }]],
  ] as const)(
    '폐지 직전 마지막 봉은 %s 전략의 유효한 리밸런스 시계로 남긴다',
    (_label, universeSchedule) => {
      const seen: Array<{ tsMs: number; isRebalanceBar: boolean; symbols: string[] }> = [];
      const strategy: TradingStrategy<unknown, null> = {
        id: 'buy-on-rebalance', version: '1', name: 'buy on rebalance', description: '',
        parameterSchema: z.object({}).passthrough(),
        initialize: () => null,
        onBars: (context) => {
          seen.push({
            tsMs: context.tsMs,
            isRebalanceBar: context.isRebalanceBar,
            symbols: [...context.bars.keys()].sort(),
          });
          return {
            orders: context.isRebalanceBar
              ? [{ symbol: 'B', side: 'BUY' as const, quantity: 1 }]
              : [],
          };
        },
      };
      const result = runBacktest(strategy, {
        candles: [bar('A', 0, 500), bar('B', 1, 700), bar('B', 2, 750)],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 1,
        maxPositions: 1,
        universeSchedule,
        delistedTsMsBySymbol: new Map([['A', [START + DAY]]]),
      });

      expect(seen[0]).toEqual({
        tsMs: START,
        isRebalanceBar: true,
        symbols: ['A'],
      });
      expect(result.fills).toMatchObject([
        { symbol: 'B', side: 'BUY', tsMs: START + DAY, price: 700 },
      ]);
    },
  );

  it('폐지된 코드를 전략 봉·이력·유니버스에서 빼고 대체 후보를 거래한다', () => {
    const seen: Array<{
      bars: string[];
      historyA: number;
      tradable: string[] | null;
      active: string[] | null;
    }> = [];
    const strategy: TradingStrategy<unknown, null> = {
      id: 'buy-first-visible', version: '1', name: 'buy first visible', description: '',
      parameterSchema: z.object({}).passthrough(),
      initialize: () => null,
      onBars: (context) => {
        if (context.tsMs > START + 2 * DAY) return { orders: [] };
        const tradable = context.tradableSymbols === null
          ? null
          : [...context.tradableSymbols].sort();
        seen.push({
          bars: [...context.bars.keys()].sort(),
          historyA: context.getHistory('A').length,
          tradable,
          active: context.activeUniverseSymbols === null
            ? null
            : [...context.activeUniverseSymbols].sort(),
        });
        if (context.tsMs !== START + 2 * DAY) return { orders: [] };
        const target = tradable?.[0];
        return {
          orders: target === undefined
            ? []
            : [{ symbol: target, side: 'BUY' as const, quantity: 1 }],
        };
      },
    };
    const result = runBacktest(strategy, {
      candles: [
        bar('A', 0), bar('A', 1, 500), bar('A', 4, 9_000),
        bar('B', 0), bar('B', 1, 700), bar('B', 2, 750), bar('B', 3, 780),
      ],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 1,
      delistedTsMsBySymbol: new Map([['A', [START + 2 * DAY]]]),
    });

    expect(seen).toEqual([
      {
        bars: ['A', 'B'],
        historyA: 1,
        tradable: null,
        active: null,
      },
      {
        bars: ['A', 'B'],
        historyA: 2,
        tradable: null,
        active: null,
      },
      {
        bars: ['B'],
        historyA: 0,
        tradable: ['B'],
        active: ['B'],
      },
    ]);
    expect(result.fills).toMatchObject([
      { symbol: 'B', side: 'BUY', tsMs: START + 3 * DAY, price: 780 },
    ]);
    // 새 발행사 A의 day4 가격·전략 입력은 버리되, CAGR 기간을 줄이지 않도록 결과 시계는 유지한다.
    expect(result.equityPoints.map((point) => point.tsMs)).toEqual([
      START,
      START + DAY,
      START + 2 * DAY,
      START + 3 * DAY,
      START + 4 * DAY,
    ]);
    expect(result.warnings.join('\n')).toContain(
      '새 발행사의 수익 기회가 반영되지 않아 결과가 보수적일 수 있습니다.',
    );
  });

  it('폐지된 BUY 유무가 정상 동시 BUY의 seeded 우선순위를 바꾸지 않는다', () => {
    const candles = [
      bar('A', 0), bar('A', 1, 500), bar('A', 4, 9_000),
      ...[0, 1, 2, 3].map((index) => bar('B', index, 700)),
      ...[0, 1, 2, 3].map((index) => bar('C', index, 800)),
    ];
    const input = {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      maxPositions: 1,
      delistedTsMsBySymbol: new Map([['A', [START + 2 * DAY]]]),
    };

    for (let randomSeed = 1; randomSeed <= 16; randomSeed += 1) {
      const withRetired = runBacktest(
        buyAtTsStrategy(new Map([[START + 2 * DAY, ['A', 'B', 'C']]])),
        { ...input, randomSeed },
      );
      const withoutRetired = runBacktest(
        buyAtTsStrategy(new Map([[START + 2 * DAY, ['B', 'C']]])),
        { ...input, randomSeed },
      );
      const normalBuyIdentity = (result: typeof withRetired) => result.fills
        .filter((fill) => fill.side === 'BUY' && fill.symbol !== 'A')
        .map((fill) => ({ symbol: fill.symbol, tsMs: fill.tsMs }));

      expect(normalBuyIdentity(withRetired)).toEqual(normalBuyIdentity(withoutRetired));
    }
  });

  it('미보유 종목의 봉 없는 폐지 이벤트가 전략·수익률 관측을 바꾸지 않는다', () => {
    const run = (withEvent: boolean) => {
      const seen: Array<{ tsMs: number; random: number }> = [];
      const strategy: TradingStrategy<unknown, null> = {
        id: 'observe-event-only', version: '1', name: 'observe event only', description: '',
        parameterSchema: z.object({}).passthrough(),
        initialize: () => null,
        onBars: (context) => {
          seen.push({ tsMs: context.tsMs, random: context.rng() });
          return { orders: [] };
        },
      };
      const result = runBacktest(strategy, {
        candles: [bar('B', 0), bar('B', 2)],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 7,
        maxPositions: 1,
        ...(withEvent
          ? { delistedTsMsBySymbol: new Map([['A', [START + DAY]]]) }
          : {}),
      });
      return {
        seen,
        equityPoints: result.equityPoints,
        metrics: result.metrics,
        monthlyReturns: result.monthlyReturns,
      };
    };

    expect(run(true)).toEqual(run(false));
  });

  it('한 코드에 폐지가 여러 번 있어도 가장 이른 경계에서 청산하고 후속 발행사를 거래하지 않는다', () => {
    // issuer epoch가 없는 동안에는 첫 폐지 뒤 같은 단축코드를 실행 끝까지 막는다.
    // 뒤 폐지가 앞 폐지를 덮어써 첫 회사 포지션을 뒷 회사 종가로 파는 것보다
    // 새 발행사의 수익 기회를 포기하는 보수적 결과가 안전하다.
    const candles = [
      bar('A', 0, 1_000), bar('A', 1, 900),
      { ...bar('A', 2, 500), open: 600, high: 610 }, // 첫 회사의 마지막 봉
      bar('A', 5, 9_000), bar('A', 6, 9_500), // 코드를 다시 받은 회사의 봉
      bar('B', 0), bar('B', 6),
    ];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY, START + 7 * DAY]]]),
    });

    const trade = result.trades.find((candidate) => candidate.symbol === 'A');
    expect(trade?.exitReason).toBe('DELISTED');
    // 첫 폐지 효력일(3번)에 나간다 — 두 번째 폐지 효력일(7번)이 아니다
    expect(trade?.exitTsMs).toBe(START + 3 * DAY);
    expect(trade?.exitPrice).toBe(500);
    expect(result.delistingLiquidations).toEqual([
      { symbol: 'A', tsMs: START + 3 * DAY, netPnl: trade?.netPnl },
    ]);
  });

  it('폐지 이전 봉이 없는 코드의 pending BUY를 효력일 첫 전역 봉 시가 전에 폐기한다', () => {
    // A 봉은 전부 이미 폐지 뒤 재사용된 코드의 봉이라 가격 입력에서 제외된다.
    // B day0 close에 낸 A 주문을 day1 시가 전에 폐기해야 B의 정상 주문이 슬롯을 얻는다.
    const result = runBacktest(
      buyAtTsStrategy(new Map([
        [START, ['A']],
        [START + DAY, ['B']],
      ])),
      {
        candles: [
          bar('A', 1, 9_000), bar('A', 2, 9_500),
          bar('B', 0), bar('B', 1),
          bar('B', 2, 1_100),
        ],
        initialCash: 1_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 1,
        maxPositions: 1,
        delistedTsMsBySymbol: new Map([['A', [START + DAY]]]),
      },
    );

    expect(result.delistingLiquidations).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
    expect(result.fills).toMatchObject([
      { symbol: 'B', side: 'BUY', tsMs: START + 2 * DAY, price: 1_100 },
    ]);
    expect(result.openPositions.map((position) => position.symbol)).toEqual(['B']);
    expect(result.warnings.join('\n')).toContain('A 주문 거부/폐기: 상장폐지 경계를 넘어');
    expect(result.warnings.join('\n')).not.toContain('동시 보유 종목 상한');
  });

  it('폐지 정보가 없으면 미청산으로 남는다', () => {
    const candles = [bar('A', 0, 1_000), bar('A', 1, 900), bar('A', 2, 500), bar('B', 3)];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(result.trades).toHaveLength(0);
    const open = result.openPositions.find((position) => position.symbol === 'A');
    expect(open?.lastPriceTsMs).toBe(START + 2 * DAY);
  });

  it('청산 시점에 onForcedExit 를 부른다', () => {
    const seen: string[] = [];
    const strategy = buyOnceStrategy('A');
    const withHook: TradingStrategy<unknown, { done: boolean }> = {
      ...strategy,
      onForcedExit: (symbol) => { seen.push(symbol); },
    };
    runBacktest(withHook, {
      candles: [bar('A', 0), bar('A', 1), bar('B', 2)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', [START + 2 * DAY]]]),
    });
    expect(seen).toEqual(['A']);
  });

  it('포지션 없는 종목에는 onForcedExit 를 부르지 않는다', () => {
    const seen: string[] = [];
    const strategy = buyOnceStrategy('A');
    const withHook: TradingStrategy<unknown, { done: boolean }> = {
      ...strategy,
      onForcedExit: (symbol) => { seen.push(symbol); },
    };
    // C 는 폐지 대상이지만 전략이 A 만 사서 C 는 한 번도 보유하지 않는다 —
    // 없는 포지션을 지우려 드는 회귀를 잡는다
    const result = runBacktest(withHook, {
      candles: [bar('A', 0), bar('A', 1), bar('C', 0), bar('C', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['C', [START + 1 * DAY]]]),
    });
    expect(seen).not.toContain('C');
    expect(result.delistingLiquidations).toHaveLength(0);
  });

  it('마지막 봉에서 낸 매수 주문은 체결될 봉이 없어도 포지션·강제청산 흔적을 남기지 않는다', () => {
    // D 는 한 봉뿐이고 그 봉이 곧 마지막 봉이다. 전략은 그 봉에서 D 를 매수하려 든다.
    // 다음 봉이 다시 오지 않으니 이 주문은 영원히 체결되지 않는다(기간 종료 폐기
    // 경고로 드러난다 — 그 경고 자체는 폐지와 무관한 기존 동작이라 여기서 재검증하지
    // 않는다). 이 테스트가 지키는 것은: 그렇게 미체결로 남는 주문이 있어도 거래·
    // 포지션·강제청산 훅에는 아무 흔적을 남기지 않는다는 점이다.
    const seen: string[] = [];
    const strategy = buyOnceStrategy('D');
    const withHook: TradingStrategy<unknown, { done: boolean }> = {
      ...strategy,
      onForcedExit: (symbol) => { seen.push(symbol); },
    };
    const result = runBacktest(withHook, {
      candles: [bar('D', 0)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['D', [START]]]),
    });

    expect(result.fills).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
    expect(result.delistingLiquidations).toHaveLength(0);
    expect(result.openPositions.some((position) => position.symbol === 'D')).toBe(false);
    // 포지션이 생긴 적 없으니 강제 청산 훅도 불리지 않는다
    expect(seen).not.toContain('D');
  });
});

describe('실행 경고', () => {
  /** "이 백테스트가 보정하는 것" 한 줄만 꺼낸다 — 다른 줄에 같은 단어가 있어 join 으로는 못 가린다 */
  function correctedLine(warnings: readonly string[]): string {
    return warnings.find((warning) => warning.startsWith('이 백테스트가 보정하는 것')) ?? '';
  }

  it('보정하는 항목과 보정하지 않는 항목을 갈라 적는다', () => {
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0), bar('A', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    const text = result.warnings.join('\n');
    expect(text).toContain('배당');
    expect(text).toContain('유상증자 권리락');
  });

  it('실제로 넘어온 입력만 보정 항목으로 적는다', () => {
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0), bar('A', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['A'] }],
      delistedTsMsBySymbol: new Map(),
      nonTradingSymbolsByTsMs: new Map(),
      nonTradingCoveredPeriod: { from: '2025-05-12', to: '2025-05-13' },
    });
    const corrected = correctedLine(result.warnings);
    expect(corrected).toContain('시점별 유니버스 선정');
    expect(corrected).toContain('상장폐지 청산');
    expect(corrected).toContain('거래불가일');
  });

  it('거래불가 정보가 없는 실행은 거래불가일 매수 제외를 보정한다고 적지 않는다', () => {
    // 같은 실행이 "거래불가일 매수를 제외한다" 와 "거래불가일 정보가 없습니다" 를
    // 함께 내보내던 자리다. 백필 전 DB 의 모든 실행이 이 모순을 그대로 실어 날랐다.
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0), bar('A', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      nonTradingCoveredPeriod: null,
    });
    expect(correctedLine(result.warnings)).not.toContain('거래불가일');
    expect(result.warnings.join('\n')).toContain('거래불가일 정보가 없습니다');
  });

  it('유니버스 일정과 폐지 정보가 없으면 그 둘도 보정 항목에서 뺀다', () => {
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0), bar('A', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    const corrected = correctedLine(result.warnings);
    expect(corrected).not.toContain('시점별 유니버스 선정');
    expect(corrected).not.toContain('상장폐지 청산');
  });

  it('거래불가 정보가 백필되지 않았으면 그 사실을 적는다', () => {
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0), bar('A', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      nonTradingCoveredPeriod: null,
    });
    expect(result.warnings.join('\n')).toContain('거래불가일 정보가 없습니다');
  });

  it('실행 구간이 전부 덮였으면 커버리지 이야기를 꺼내지 않는다', () => {
    // 워커는 실행 기간 전체가 덮였을 때만 구간을 넘긴다. 그 구간을 다시 적으면
    // "만" 이 붙어 일부만 반영된 것처럼 읽힌다 — 사실은 전부 반영됐다.
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0), bar('A', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      nonTradingCoveredPeriod: { from: '2025-05-12', to: '2025-05-13' },
    });
    const text = result.warnings.join('\n');
    expect(text).not.toContain('거래불가일 정보가 없습니다');
    expect(text).not.toContain('거래불가일 정보는');
  });

  it('청산 손익을 ko-KR 자릿수 구분으로 적는다', () => {
    // 로캘을 지정하지 않으면 같은 실행이 기계마다 1,234,567 과 1.234.567 로 갈려
    // warningsJson 이 달라진다 — 재현성(ENGINE_VERSION·scheduleHash) 약속이 깨진다.
    const candles = [
      bar('A', 0, 1_000), bar('A', 1, 1_000),
      { ...bar('A', 2, 3_000), open: 3_000, high: 3_010 },
      bar('B', 0), bar('B', 3),
    ];
    const result = runBacktest(
      {
        ...buyOnceStrategy('A'),
        onBars: (_context, state) => {
          if ((state as { done: boolean }).done) return { orders: [] };
          (state as { done: boolean }).done = true;
          return { orders: [{ symbol: 'A', side: 'BUY' as const, quantity: 1_000 }] };
        },
      },
      {
        candles,
        initialCash: 10_000_000,
        execution: ZERO_COST,
        parameters: {},
        randomSeed: 1,
        maxPositions: 5,
        delistedTsMsBySymbol: new Map([['A', [START + 3 * DAY]]]),
      },
    );

    const netPnl = result.delistingLiquidations[0]?.netPnl ?? 0;
    expect(Math.abs(netPnl)).toBeGreaterThan(1_000_000);
    expect(result.warnings.join('\n')).toContain(
      `손익 합계 ${Math.round(netPnl).toLocaleString('ko-KR')}원`,
    );
  });
});
