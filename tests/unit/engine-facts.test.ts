import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 4, 12); // 2025-05-12

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function bar(index: number): Candle {
  return {
    symbol: '005930',
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * DAY,
    open: 1_000,
    high: 1_010,
    low: 990,
    close: 1_000,
    volume: 100,
  };
}

/** 봉마다 보이는 영업이익을 기록하는 관찰 전략 */
function observingStrategy(): {
  strategy: TradingStrategy<unknown, null>;
  seen: Array<number | null>;
} {
  const seen: Array<number | null> = [];
  return {
    seen,
    strategy: {
      id: 'observe',
      version: '1.0.0',
      name: 'observe',
      description: 'test',
      parameterSchema: z.unknown(),
      initialize: () => null,
      onBars(context) {
        seen.push(context.fundamentals('005930')?.get('OPERATING_INCOME') ?? null);
        return { orders: [] };
      },
    },
  };
}

describe('엔진 PIT 배선', () => {
  it('공시 시각 이전 봉에는 재무가 보이지 않고 이후 봉에만 보인다', () => {
    // 봉 2(2025-05-14) 보다 늦고 봉 3(2025-05-15) 보다 이른 시각에 공시
    const disclosed = START + 2 * DAY + 3_600_000;
    const facts: Fact[] = [
      {
        scope: 'SYMBOL',
        key: '005930',
        field: 'OPERATING_INCOME',
        periodKey: '2025Q1',
        asOfTsMs: disclosed,
        value: 100,
        unit: 'KRW',
      },
    ];

    const { strategy, seen } = observingStrategy();
    runBacktest(strategy, {
      candles: [bar(0), bar(1), bar(2), bar(3), bar(4)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      facts,
    });

    expect(seen.slice(0, 3)).toEqual([null, null, null]);
    expect(seen.slice(3)).toEqual([100, 100]);
  });

  it('facts 를 넘기지 않으면 fundamentals 는 항상 null (기존 전략 호환)', () => {
    const { strategy, seen } = observingStrategy();
    runBacktest(strategy, {
      candles: [bar(0), bar(1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(seen).toEqual([null, null]);
  });

  it('기준일 이후 봉에서만 자본변동 이벤트가 보인다', () => {
    const announced = START - 5 * DAY;
    const facts: Fact[] = [
      {
        scope: 'SYMBOL',
        key: '005930',
        field: 'SPLIT_RATIO',
        periodKey: '2025-05-14', // 봉 2 의 날짜
        asOfTsMs: announced,
        value: 2,
        unit: 'RATIO',
      },
    ];

    const counts: number[] = [];
    const strategy: TradingStrategy<unknown, null> = {
      id: 'observe-actions',
      version: '1.0.0',
      name: 'observe',
      description: 'test',
      parameterSchema: z.unknown(),
      initialize: () => null,
      onBars(context) {
        counts.push(context.corporateActions('005930').length);
        return { orders: [] };
      },
    };

    runBacktest(strategy, {
      candles: [bar(0), bar(1), bar(2), bar(3)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      facts,
    });

    // 봉 0(05-12)·1(05-13) 은 기준일 전 → 0. 봉 2(05-14)·3(05-15) 은 이후 → 1
    expect(counts).toEqual([0, 0, 1, 1]);
  });

  /**
   * 사업보고서 지연 회귀 (설계 §3.4). 자본변동 수량은 사업보고서의 증자·감자 현황에서
   * 읽으므로 접수일(asOf)이 기준일보다 최대 15개월 늦다. asOf 로도 게이트하면 이 실행
   * 구간 전체에서 분할이 뷰에 없고, 모멘텀은 미보정 가격에서 −50% 를 읽어 기본 절대
   * 모멘텀 필터가 그 종목을 조용히 떨어뜨린다.
   */
  it('공시 접수일이 봉 구간보다 늦어도 기준일이 지난 자본변동은 전략에 보인다', () => {
    const facts: Fact[] = [
      {
        scope: 'SYMBOL',
        key: '005930',
        field: 'SPLIT_RATIO',
        periodKey: '2025-05-14', // 봉 2 의 날짜 — 기준일
        asOfTsMs: START + 400 * DAY, // 마지막 봉보다 한참 뒤에 접수된 사업보고서
        value: 2,
        unit: 'RATIO',
      },
    ];

    const counts: number[] = [];
    const strategy: TradingStrategy<unknown, null> = {
      id: 'observe-actions-late-filing',
      version: '1.0.0',
      name: 'observe',
      description: 'test',
      parameterSchema: z.unknown(),
      initialize: () => null,
      onBars(context) {
        counts.push(context.corporateActions('005930').length);
        return { orders: [] };
      },
    };

    runBacktest(strategy, {
      candles: [bar(0), bar(1), bar(2), bar(3)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      facts,
    });

    // 기준일 게이트만 적용된다 — 봉 0·1 은 기준일 전, 봉 2·3 은 이후
    expect(counts).toEqual([0, 0, 1, 1]);
  });

  it('경고 문구는 분할이 보정된다는 사실을 반영한다', () => {
    const { strategy } = observingStrategy();
    const result = runBacktest(strategy, {
      candles: [bar(0)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    const biasWarning = result.warnings.find((warning) => warning.includes('생존 편향'));
    expect(biasWarning).toBeDefined();
    expect(biasWarning).toContain('배당');
  });

  it('facts 를 넘기지 않으면 경고가 액면분할도 보정되지 않았다고 말한다', () => {
    const { strategy } = observingStrategy();
    const result = runBacktest(strategy, {
      candles: [bar(0)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      // facts 미지정 — 어떤 전략도 분할을 보정할 재료가 없다
    });
    const biasWarning = result.warnings.find((warning) => warning.includes('생존 편향'));
    expect(biasWarning).toBeDefined();
    expect(biasWarning).toContain('액면분할도 이 실행에서는 보정되지 않았습니다');
    expect(biasWarning).not.toContain('신호 계산');
  });

  it('재무 팩트만 있고 분할 이력이 없으면 보정했다고 말하지 않는다', () => {
    // 데이터셋에 재무는 있는데 SPLIT_RATIO 가 0건인 상태는 흔하다 — 팩트 건수로만
    // 판단하면 일어나지 않은 보정을 일어났다고 주장한다.
    const { strategy } = observingStrategy();
    const result = runBacktest(strategy, {
      candles: [bar(0)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      facts: [
        {
          scope: 'SYMBOL',
          key: '005930',
          field: 'OPERATING_INCOME',
          periodKey: '2025Q1',
          asOfTsMs: START - DAY,
          value: 100,
          unit: 'KRW',
        },
      ],
    });
    const biasWarning = result.warnings.find((warning) => warning.includes('생존 편향'));
    expect(biasWarning).toContain('액면분할도 이 실행에서는 보정되지 않았습니다');
    expect(biasWarning).not.toContain('신호 계산');
  });

  it('facts 를 넘기면 경고가 분할 보정은 전략의 신호 계산에 한정된다고 말한다', () => {
    const { strategy } = observingStrategy();
    const facts: Fact[] = [
      {
        scope: 'SYMBOL',
        key: '005930',
        field: 'SPLIT_RATIO',
        periodKey: '2025-05-12',
        asOfTsMs: START - DAY,
        value: 2,
        unit: 'RATIO',
      },
    ];
    const result = runBacktest(strategy, {
      candles: [bar(0)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      facts,
    });
    const biasWarning = result.warnings.find((warning) => warning.includes('생존 편향'));
    expect(biasWarning).toBeDefined();
    expect(biasWarning).toContain('보정을 사용하는 전략의 신호 계산에만 반영됩니다');
    expect(biasWarning).toContain('체결가는 실제 거래 가격입니다');
  });
});
