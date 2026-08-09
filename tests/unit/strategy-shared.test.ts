import { describe, expect, it } from 'vitest';
import type { Position } from '../../src/server/modules/backtest/domain/types.js';
import type { CorporateAction } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { splitAdjustedClose } from '../../src/server/modules/strategy/strategies/shared/adjusted-price.js';
import {
  combineRanks,
  ordinalRank,
} from '../../src/server/modules/strategy/strategies/shared/fundamental-rank.js';
import { rankDescending } from '../../src/server/modules/strategy/strategies/shared/rank.js';
import {
  planBuyPhase,
  planSellPhase,
} from '../../src/server/modules/strategy/strategies/shared/two-phase-rebalance.js';

const DAY = 86_400_000;

function candle(tsMs: number, close: number, symbol = 'A'): Candle {
  return {
    symbol,
    market: 'KR',
    timeframe: '1d',
    tsMs,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  };
}

function position(symbol: string, quantity: number): Position {
  return { symbol, quantity, avgEntryPrice: 100, entryCosts: 0, entryTsMs: 0 };
}

describe('rankDescending', () => {
  it('큰 값이 1위다', () => {
    const ranks = rankDescending([
      { symbol: 'A', score: 0.1 },
      { symbol: 'B', score: 0.5 },
      { symbol: 'C', score: 0.3 },
    ]);
    expect(ranks.get('B')).toBe(1);
    expect(ranks.get('C')).toBe(2);
    expect(ranks.get('A')).toBe(3);
  });

  it('동점은 심볼 코드 오름차순으로 깬다 — 결정적이어야 한다', () => {
    const ranks = rankDescending([
      { symbol: 'B', score: 0.5 },
      { symbol: 'A', score: 0.5 },
    ]);
    expect(ranks.get('A')).toBe(1);
    expect(ranks.get('B')).toBe(2);
  });

  it('입력 순서가 달라도 같은 결과가 나온다', () => {
    const forward = rankDescending([
      { symbol: 'A', score: 1 },
      { symbol: 'B', score: 1 },
      { symbol: 'C', score: 2 },
    ]);
    const reversed = rankDescending([
      { symbol: 'C', score: 2 },
      { symbol: 'B', score: 1 },
      { symbol: 'A', score: 1 },
    ]);
    expect([...forward.entries()].sort()).toEqual([...reversed.entries()].sort());
  });

  it('입력 배열을 변형하지 않는다', () => {
    const items = [
      { symbol: 'A', score: 1 },
      { symbol: 'B', score: 2 },
    ];
    rankDescending(items);
    expect(items[0]?.symbol).toBe('A');
  });
});

describe('fundamental ordinal rank', () => {
  it('ASC와 DESC를 각각 적용하고 입력 순서와 무관하게 코드로 동점을 깬다', () => {
    const rows = [
      { code: 'B', low: 1, high: 2 },
      { code: 'A', low: 1, high: 3 },
      { code: 'C', low: 3, high: 1 },
    ];
    const low = ordinalRank(rows, (row) => row.low, 'ASC', (row) => row.code);
    const high = ordinalRank(rows, (row) => row.high, 'DESC', (row) => row.code);
    expect(low.get(rows[1] as (typeof rows)[number])).toBe(1);
    expect(low.get(rows[0] as (typeof rows)[number])).toBe(2);
    expect(combineRanks(rows, [low, high], (row) => row.code).map((row) => row.code)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });
});

describe('splitAdjustedClose', () => {
  const history = [candle(0, 200), candle(DAY, 200), candle(2 * DAY, 100), candle(3 * DAY, 110)];
  // 2일차(2*DAY)에 2:1 분할 발생
  const actions: CorporateAction[] = [{ effectiveTsMs: 2 * DAY, ratio: 2 }];

  it('분할 이전 봉은 배수로 나눈다', () => {
    expect(splitAdjustedClose(history, actions, 0)).toBe(100);
    expect(splitAdjustedClose(history, actions, 1)).toBe(100);
  });

  it('분할 이후 봉은 그대로다', () => {
    expect(splitAdjustedClose(history, actions, 2)).toBe(100);
    expect(splitAdjustedClose(history, actions, 3)).toBe(110);
  });

  it('보정하면 거짓 -50% 가 사라진다', () => {
    const raw = (history[2] as Candle).close / (history[0] as Candle).close - 1;
    const from = splitAdjustedClose(history, actions, 0) as number;
    const to = splitAdjustedClose(history, actions, 2) as number;
    expect(raw).toBeCloseTo(-0.5);
    expect(to / from - 1).toBeCloseTo(0);
  });

  it('이벤트가 여러 개면 배수를 곱한다', () => {
    const many: CorporateAction[] = [
      { effectiveTsMs: DAY, ratio: 2 },
      { effectiveTsMs: 2 * DAY, ratio: 5 },
    ];
    expect(splitAdjustedClose(history, many, 0)).toBe(20);
  });

  it('이벤트가 없으면 종가 그대로', () => {
    expect(splitAdjustedClose(history, [], 0)).toBe(200);
  });

  it('범위 밖 index 는 null', () => {
    expect(splitAdjustedClose(history, actions, 99)).toBeNull();
    expect(splitAdjustedClose(history, actions, -1)).toBeNull();
  });
});

describe('planSellPhase', () => {
  it('목표에 없는 보유 종목만 전량 매도한다', () => {
    const positions = new Map<string, Position>([
      ['A', position('A', 10)],
      ['B', position('B', 5)],
    ]);
    expect(planSellPhase({ targets: ['A', 'C'], positions })).toEqual([
      { symbol: 'B', side: 'SELL', quantity: 5, reason: 'REBALANCE_EXIT' },
    ]);
  });

  it('전량 회전이면 보유 전부를 매도한다', () => {
    const positions = new Map<string, Position>([
      ['A', position('A', 10)],
      ['B', position('B', 5)],
    ]);
    expect(planSellPhase({ targets: ['C', 'D'], positions }).map((o) => o.symbol)).toEqual([
      'A',
      'B',
    ]);
  });

  it('수량 0 포지션은 주문을 내지 않는다', () => {
    const positions = new Map<string, Position>([['A', position('A', 0)]]);
    expect(planSellPhase({ targets: [], positions })).toEqual([]);
  });

  it('주문 순서는 심볼 코드 순으로 결정적이다', () => {
    const positions = new Map<string, Position>([
      ['C', position('C', 1)],
      ['A', position('A', 1)],
      ['B', position('B', 1)],
    ]);
    expect(planSellPhase({ targets: [], positions }).map((o) => o.symbol)).toEqual(['A', 'B', 'C']);
  });
});

describe('planBuyPhase', () => {
  const bars = new Map<string, Candle>([
    ['A', candle(0, 1_000, 'A')],
    ['B', candle(0, 500, 'B')],
  ]);

  it('동일가중으로 수량을 낸다', () => {
    // 종목당 예산 10,000/2 = 5,000 → A 5주, B 10주
    expect(planBuyPhase(['A', 'B'], { positions: new Map(), bars, equity: 10_000, topN: 2 })).toEqual(
      [
        { symbol: 'A', side: 'BUY', quantity: 5, reason: 'REBALANCE_ENTRY' },
        { symbol: 'B', side: 'BUY', quantity: 10, reason: 'REBALANCE_ENTRY' },
      ],
    );
  });

  it('이미 보유 중인 종목은 매수하지 않는다', () => {
    const orders = planBuyPhase(['A', 'B'], {
      positions: new Map([['A', position('A', 3)]]),
      bars,
      equity: 10_000,
      topN: 2,
    });
    expect(orders.map((o) => o.symbol)).toEqual(['B']);
  });

  it('이번 봉에 봉이 없는 종목은 건너뛴다 (거래정지 등)', () => {
    const orders = planBuyPhase(['A', 'Z'], {
      positions: new Map(),
      bars,
      equity: 10_000,
      topN: 2,
    });
    expect(orders.map((o) => o.symbol)).toEqual(['A']);
  });

  it('1주도 못 사면 주문을 내지 않는다', () => {
    expect(planBuyPhase(['A'], { positions: new Map(), bars, equity: 100, topN: 2 })).toEqual([]);
  });

  it('비중은 목표 종목 수가 아니라 topN 으로 나눈다 — 남는 몫은 현금', () => {
    // 10,000/4 = 2,500 → 1,000원 종목 2주
    const orders = planBuyPhase(['A'], { positions: new Map(), bars, equity: 10_000, topN: 4 });
    expect(orders[0]?.quantity).toBe(2);
  });
});
