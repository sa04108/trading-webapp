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
  it('마지막 거래 가능 봉 종가로 청산하고 사유를 남긴다', () => {
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
    expect(trade?.exitTsMs).toBe(START + 2 * DAY);
    expect(result.delistingLiquidations).toHaveLength(1);
    // 청산했으니 미청산으로 남지 않는다
    expect(result.openPositions.some((position) => position.symbol === 'A')).toBe(false);
  });

  it('폐지 시각 뒤에도 봉이 있으면 그 시각 직전 봉에서 청산한다', () => {
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
    expect(trade?.exitTsMs).toBe(START + 2 * DAY);
    expect(trade?.exitPrice).toBe(500);
    expect(result.delistingLiquidations).toEqual([
      { symbol: 'A', tsMs: START + 2 * DAY, netPnl: trade?.netPnl },
    ]);
  });

  it('한 코드가 기간 안에 두 번 폐지되면 각 폐지 직전 봉에서 청산한다', () => {
    // KRX 가 여섯 자리 단축코드를 재사용하므로 한 코드가 실행 기간 안에서 두 번
    // 폐지될 수 있다. 폐지 시각을 코드당 하나만 들고 있으면 뒤 폐지가 앞 폐지를
    // 덮어써, 앞 회사를 들고 있던 포지션이 몇 년 뒤 뒷 회사 종가로 나간다.
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
    // 첫 폐지 직전 봉(2번)에서 나간다 — 두 번째 폐지 직전 봉(6번, 9,500)이 아니다
    expect(trade?.exitTsMs).toBe(START + 2 * DAY);
    expect(trade?.exitPrice).toBe(500);
    expect(result.delistingLiquidations).toEqual([
      { symbol: 'A', tsMs: START + 2 * DAY, netPnl: trade?.netPnl },
    ]);
  });

  it('폐지 시각 이전 봉이 하나도 없으면 청산하지 않는다', () => {
    // 폐지 효력일이 실행 기간 첫 봉보다 앞선 경우다. 청산할 자리가 없으므로
    // 아무 일도 일어나지 않아야 한다 — 마지막 봉으로 밀어 청산하면 폐지 뒤 가격으로 판다.
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0, 1_000), bar('A', 1, 900), bar('A', 2, 500)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', [START]]]),
    });

    expect(result.delistingLiquidations).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
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
    // "생존 편향" 이라는 단일 라벨은 더 이상 쓰지 않는다 — 부분 보정이라 예/아니오로 말할 수 없다
    expect(text).not.toContain('생존 편향');
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
