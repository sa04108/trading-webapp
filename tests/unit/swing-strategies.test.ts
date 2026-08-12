import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile, Fill } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle, Timeframe } from '../../src/server/modules/market-data/domain/candle.js';
import {
  emaTrendSwitchStrategy,
  type EmaTrendSwitchState,
} from '../../src/server/modules/strategy/strategies/ema-trend-switch.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

const FAST_PARAMS = {
  fastEmaBars: 3,
  slowEmaBars: 6,
  entryThresholdPercent: 0.3,
  atrPeriod: 3,
  stopAtrMultiplier: 2,
  trailAtrMultiplier: 2,
  riskPerTradePercent: 1,
  correlationBars: 20,
  correlationThreshold: 0.5,
};

/** 워밍업 진동 후 상승 추세인 경로와 그 역수(완전 역상관) 경로 */
function levPath(bars: number, warmup: number): number[] {
  return Array.from({ length: bars }, (_, index) =>
    index < warmup ? 1_000 + (index % 2 === 0 ? 10 : -10) : 1_000 + (index - warmup + 1) * 15,
  );
}

function toCandles(
  closesBySymbol: ReadonlyMap<string, readonly number[]>,
  timeframe: Timeframe,
  stepMs: number,
): Candle[] {
  const candles: Candle[] = [];
  for (const [symbol, closes] of closesBySymbol) {
    closes.forEach((close, index) => {
      candles.push({
        symbol,
        market: 'KR',
        timeframe,
        tsMs: START + index * stepMs,
        open: close,
        high: close * 1.01,
        low: close * 0.99,
        close,
        volume: 1_000,
      });
    });
  }
  return candles.sort((a, b) => a.tsMs - b.tsMs || (a.symbol < b.symbol ? -1 : 1));
}

function fillSignature(fills: readonly Fill[]): string[] {
  return fills.map((fill) => `${fill.symbol}:${fill.side}:${fill.quantity}:${fill.reason ?? ''}`);
}

function run(closesBySymbol: ReadonlyMap<string, readonly number[]>, timeframe: Timeframe, stepMs: number) {
  return runBacktest(emaTrendSwitchStrategy, {
    candles: toCandles(closesBySymbol, timeframe, stepMs),
    initialCash: 10_000_000,
    execution: ZERO_COST,
    parameters: FAST_PARAMS,
    randomSeed: 1,
    maxPositions: 5,
  });
}

describe('방향 무지 — 전략은 어느 종목이 인버스인지 모른다', () => {
  it('심볼 이름을 서로 바꿔도 결과가 대칭이다', () => {
    const lev = levPath(60, 25);
    const inv = lev.map((value) => 1_000_000 / value);

    const original = run(new Map([['AAA', lev], ['BBB', inv]]), '1d', DAY);
    const swapped = run(new Map([['AAA', inv], ['BBB', lev]]), '1d', DAY);

    // 원본에서 AAA(상승 경로)가 산 것을, 교환본에서는 BBB 가 산다
    const relabel = (signature: string): string =>
      signature.startsWith('AAA:')
        ? signature.replace(/^AAA:/, 'BBB:')
        : signature.replace(/^BBB:/, 'AAA:');
    expect(fillSignature(swapped.fills)).toEqual(fillSignature(original.fills).map(relabel));
  });
});

describe('그룹 배타성', () => {
  it('같은 봉에서 역상관 짝이 둘 다 신호를 내면 사전순 첫 종목만 산다', () => {
    // 워밍업(25봉)은 완전 역상관 진동, 이후 **둘 다** 상승 — 그룹은 워밍업에서
    // 이미 고정됐으므로 동시 신호가 나도 한쪽만 통과해야 한다
    const both: number[] = [];
    const bothInv: number[] = [];
    for (let index = 0; index < 60; index += 1) {
      if (index < 25) {
        const value = 1_000 + (index % 2 === 0 ? 10 : -10);
        both.push(value);
        bothInv.push(1_000_000 / value);
      } else {
        both.push((both[index - 1] as number) + 15);
        bothInv.push((bothInv[index - 1] as number) + 15);
      }
    }
    const result = run(new Map([['AAA', both], ['BBB', bothInv]]), '1d', DAY);
    const buySymbols = new Set(
      result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol),
    );
    // 상승 추세가 뚜렷하므로 진입은 반드시 일어나고, 그룹 배타로 정확히 1종목 —
    // 같은 봉 동시 신호는 사전순 첫 종목(AAA)이 이긴다
    expect([...buySymbols]).toEqual(['AAA']);
  });

  it('한쪽이 5봉 늦게 상장해도(들쭉날쭉 커버리지) 역상관 짝을 동시에 사지 않는다', () => {
    // 종가를 배열 인덱스로 누적하면 BBB 의 첫 종가가 AAA 의 6번째 봉과 대응해
    // 5봉(홀수) 밀린다 — 진동 구간의 완전 역상관이 +1 로 뒤집혀 그룹이 병합되지
    // 않고 양쪽을 동시에 산다. 봉 시각으로 맞춰야 병합된다.
    const aaa: number[] = [];
    const bbb: number[] = [];
    for (let index = 0; index < 60; index += 1) {
      if (index < 25) {
        const value = 1_000 + (index % 2 === 0 ? 10 : -10);
        aaa.push(value);
        bbb.push(1_000_000 / value); // 완전 역상관
      } else {
        aaa.push((aaa[index - 1] as number) + 15); // 이후 둘 다 상승 — 동시 신호
        bbb.push((bbb[index - 1] as number) + 15);
      }
    }
    const candles = [
      ...toCandles(new Map([['AAA', aaa]]), '1d', DAY),
      // BBB 는 6번째 봉(index 5)부터 존재한다 — 시각은 AAA 와 같은 격자
      ...toCandles(new Map([['BBB', bbb.slice(5)]]), '1d', DAY).map((candle) => ({
        ...candle,
        tsMs: candle.tsMs + 5 * DAY,
      })),
    ].sort((a, b) => a.tsMs - b.tsMs || (a.symbol < b.symbol ? -1 : 1));

    const result = runBacktest(emaTrendSwitchStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    const buySymbols = new Set(
      result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol),
    );
    // 공통 봉 20개는 index 24 에 차므로 상승(index 25~) 전에 그룹이 확정된다
    expect([...buySymbols]).toEqual(['AAA']);
  });

  it('비활성 종목의 신호가 활성 종목의 진입을 선점하지 않는다', () => {
    const inactiveFirst: number[] = [];
    const activeSecond: number[] = [];
    for (let index = 0; index < 60; index += 1) {
      if (index < 25) {
        const value = 1_000 + (index % 2 === 0 ? 10 : -10);
        inactiveFirst.push(value);
        activeSecond.push(1_000_000 / value);
      } else {
        inactiveFirst.push((inactiveFirst[index - 1] as number) + 15);
        activeSecond.push((activeSecond[index - 1] as number) + 15);
      }
    }

    const result = runBacktest(emaTrendSwitchStrategy, {
      candles: toCandles(
        new Map([
          ['AAA', inactiveFirst],
          ['ZZZ', activeSecond],
        ]),
        '1d',
        DAY,
      ),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['ZZZ'] }],
    });

    expect(result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol)).toEqual([
      'ZZZ',
    ]);
    expect(result.warnings.some((warning) => warning.includes('AAA 매수 거부'))).toBe(false);
  });

  it('새 멤버십이 활성화되면 그 종목들의 상관 그룹을 다시 계산한다', () => {
    const aaa = Array.from({ length: 40 }, (_, index) =>
      1_000 + (index % 2 === 0 ? 10 : -10),
    );
    const bbb = aaa.slice(10).map((value) => 1_000_000 / value);
    let finalState: EmaTrendSwitchState | undefined;
    const observingStrategy = {
      ...emaTrendSwitchStrategy,
      initialize(context: Parameters<typeof emaTrendSwitchStrategy.initialize>[0]) {
        finalState = emaTrendSwitchStrategy.initialize(context);
        return finalState;
      },
    };
    const candles = [
      ...toCandles(new Map([['AAA', aaa]]), '1d', DAY),
      ...toCandles(new Map([['BBB', bbb]]), '1d', DAY).map((bar) => ({
        ...bar,
        tsMs: bar.tsMs + 10 * DAY,
      })),
    ].sort((a, b) => a.tsMs - b.tsMs || (a.symbol < b.symbol ? -1 : 1));

    runBacktest(observingStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, symbols: ['AAA'] },
        { fromTsMs: START + 30 * DAY, symbols: ['AAA', 'BBB'] },
      ],
    });

    expect(finalState?.groupOf?.get('AAA')).toBe('AAA');
    expect(finalState?.groupOf?.get('BBB')).toBe('AAA');
  });

  it('새 멤버십 종목의 워밍업이 부족하면 이전 그룹을 재사용하지 않는다', () => {
    const aaa = levPath(40, 25);
    const bbb = [1_000, 1_020];
    let finalState: EmaTrendSwitchState | undefined;
    const observingStrategy = {
      ...emaTrendSwitchStrategy,
      initialize(context: Parameters<typeof emaTrendSwitchStrategy.initialize>[0]) {
        finalState = emaTrendSwitchStrategy.initialize(context);
        return finalState;
      },
    };
    const candles = [
      ...toCandles(new Map([['AAA', aaa]]), '1d', DAY),
      ...toCandles(new Map([['BBB', bbb]]), '1d', DAY).map((bar) => ({
        ...bar,
        tsMs: bar.tsMs + 38 * DAY,
      })),
    ].sort((a, b) => a.tsMs - b.tsMs || (a.symbol < b.symbol ? -1 : 1));

    runBacktest(observingStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, symbols: ['AAA'] },
        { fromTsMs: START + 38 * DAY, symbols: ['BBB'] },
      ],
    });

    expect(finalState?.groupOf).toBeNull();
  });

  it('활성 종목이 같아도 리밸런스 봉에서는 최근 상관으로 그룹을 갱신한다', () => {
    const aaa: number[] = [];
    const bbb: number[] = [];
    for (let index = 0; index < 45; index += 1) {
      if (index < 20) {
        const value = 1_000 + (index % 2 === 0 ? 10 : -10);
        aaa.push(value);
        bbb.push(1_000_000 / value);
      } else {
        aaa.push((aaa[index - 1] as number) + 10);
        bbb.push((bbb[index - 1] as number) + 10);
      }
    }
    let finalState: EmaTrendSwitchState | undefined;
    const observingStrategy = {
      ...emaTrendSwitchStrategy,
      initialize(context: Parameters<typeof emaTrendSwitchStrategy.initialize>[0]) {
        finalState = emaTrendSwitchStrategy.initialize(context);
        return finalState;
      },
    };

    runBacktest(observingStrategy, {
      candles: toCandles(new Map([['AAA', aaa], ['BBB', bbb]]), '1d', DAY),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, symbols: ['AAA', 'BBB'] },
        { fromTsMs: START + 40 * DAY, symbols: ['AAA', 'BBB'] },
      ],
    });

    expect(finalState?.groupOf?.get('AAA')).toBe('AAA');
    expect(finalState?.groupOf?.get('BBB')).toBe('BBB');
  });

  it('보유 중인 역상관 종목이 거래정지여도 같은 그룹 종목을 추가 매수하지 않는다', () => {
    const aaa: number[] = [];
    const bbb: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      if (index < 25) {
        const value = 1_000 + (index % 2 === 0 ? 10 : -10);
        aaa.push(value);
        bbb.push(1_000_000 / value);
      } else {
        aaa.push((aaa[index - 1] as number) + 20);
        bbb.push(
          index < 31
            ? (bbb[index - 1] as number) - 15
            : (bbb[index - 1] as number) + 40,
        );
      }
    }

    const result = runBacktest(emaTrendSwitchStrategy, {
      candles: toCandles(new Map([['AAA', aaa], ['BBB', bbb]]), '1d', DAY),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['AAA', 'BBB'] }],
      nonTradingSymbolsByTsMs: new Map([
        [START + 36 * DAY, new Set(['AAA'])],
      ]),
    });

    expect(result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol)).toEqual([
      'AAA',
    ]);
  });
});
