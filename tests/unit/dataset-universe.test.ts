import { describe, expect, it } from 'vitest';
import {
  MAX_UNIVERSE_SYMBOLS,
  selectUniverse,
} from '../../src/web/features/backtests/dataset-universe.js';
import type { SymbolMetricsMap } from '../../src/web/features/datasets/symbol-sort.js';
import { backtestRequestSchema } from '../../src/shared/schemas/backtest-request.js';

/** 코드가 클수록 시가총액이 큰 N종목 — 정렬이 실제로 적용됐는지 눈으로 확인된다 */
function members(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    code: String(index).padStart(6, '0'),
    name: `종목${String(index).padStart(4, '0')}`,
  }));
}

function marketCaps(count: number): SymbolMetricsMap {
  return new Map(
    members(count).map((member, index) => [
      member.code,
      { marketCap: index, tradingValue: null, tradingVolume: null },
    ]),
  );
}

describe('selectUniverse', () => {
  it('상한 이하면 전 종목을 담고 잘리지 않았다고 답한다', () => {
    const result = selectUniverse(members(30), 'MARKET_CAP', marketCaps(30));
    expect(result.symbols).toHaveLength(30);
    expect(result.truncated).toBe(false);
    expect(result.droppedCount).toBe(0);
  });

  // 앞에서 200개를 자르면 그 200개는 가나다순 앞자리일 뿐이고,
  // 「시가총액 상위 200종목으로 돌린다」 와는 완전히 다른 실험이 된다
  it('상한을 넘으면 정렬 상위 N종목만 담는다', () => {
    const total = 1_000;
    const result = selectUniverse(members(total), 'MARKET_CAP', marketCaps(total));

    expect(result.symbols).toHaveLength(MAX_UNIVERSE_SYMBOLS);
    expect(result.total).toBe(total);
    expect(result.truncated).toBe(true);
    expect(result.droppedCount).toBe(total - MAX_UNIVERSE_SYMBOLS);
    // 시가총액이 큰 순서 = 코드 내림차순
    expect(result.symbols[0]).toBe('000999');
    expect(result.symbols.at(-1)).toBe('000800');
  });

  it('정렬 기준을 바꾸면 담기는 종목이 바뀐다', () => {
    const total = 300;
    const metrics: SymbolMetricsMap = new Map(
      members(total).map((member, index) => [
        member.code,
        { marketCap: index, tradingValue: total - index, tradingVolume: null },
      ]),
    );

    const byCap = selectUniverse(members(total), 'MARKET_CAP', metrics);
    const byValue = selectUniverse(members(total), 'TRADING_VALUE', metrics);
    expect(byCap.symbols[0]).toBe('000299');
    expect(byValue.symbols[0]).toBe('000000');
    expect(new Set(byCap.symbols)).not.toEqual(new Set(byValue.symbols));
  });

  // 지표가 아직 안 왔을 때도 유니버스는 나와야 한다 — 그때는 가나다순 상위 N종목이다
  it('지표가 비어 있으면 가나다순으로 자른다', () => {
    const result = selectUniverse(members(250), 'MARKET_CAP', new Map());
    expect(result.symbols).toHaveLength(MAX_UNIVERSE_SYMBOLS);
    expect(result.symbols[0]).toBe('000000');
  });

  it('빈 데이터셋은 빈 유니버스다', () => {
    expect(selectUniverse([], 'MARKET_CAP', new Map())).toEqual({
      symbols: [],
      total: 0,
      truncated: false,
      droppedCount: 0,
    });
  });

  /**
   * 상한이 두 곳에 적혀 어긋나면 화면이 통과시킨 유니버스를 서버가 422 로 막는다 —
   * 그 어긋남은 제출해 봐야만 드러난다. 같은 상수를 쓰는지 스키마로 직접 확인한다.
   */
  it('상한 그대로 만든 유니버스는 요청 스키마를 통과하고, 하나 더 넣으면 막힌다', () => {
    const request = {
      strategyId: 'rsi-reversion',
      parameters: {},
      datasetId: 'ds_1',
      universe: {
        type: 'SYMBOLS' as const,
        symbols: selectUniverse(members(1_000), 'MARKET_CAP', marketCaps(1_000)).symbols,
      },
      period: { from: '2024-01-01', to: '2024-12-31' },
      capital: { initialCash: 10_000_000, currency: 'KRW' as const },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN' as const,
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
      },
      risk: { maxPositions: 20 },
    };

    expect(backtestRequestSchema.safeParse(request).success).toBe(true);
    expect(
      backtestRequestSchema.safeParse({
        ...request,
        universe: { type: 'SYMBOLS', symbols: [...request.universe.symbols, 'EXTRA1'] },
      }).success,
    ).toBe(false);
  });
});
