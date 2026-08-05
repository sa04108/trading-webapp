import { describe, expect, it } from 'vitest';
import {
  backtestRequestSchema,
  periodToTsRange,
} from '../../src/shared/schemas/backtest-request.js';
import { MAX_UNIVERSE_SYMBOLS } from '../../src/shared/schemas/universe-limit.js';

describe('periodToTsRange', () => {
  it('구간은 to 일자의 끝까지 포함한다 (UTC)', () => {
    const { fromTsMs, toTsMs } = periodToTsRange({ from: '2025-07-27', to: '2026-07-24' });
    expect(fromTsMs).toBe(Date.UTC(2025, 6, 27, 0, 0, 0, 0));
    expect(toTsMs).toBe(Date.UTC(2026, 6, 24, 23, 59, 59, 999));
  });

});

/** universeRule 없이는 성립하지 않는 나머지 필드들 — 각 테스트가 필요한 만큼만 덮어쓴다 */
function baseRequest(): Record<string, unknown> {
  return {
    strategyId: 'range-breakout',
    parameters: {},
    universeRule: { markets: ['KOSPI'], topN: 50, sortKey: 'MKTCAP' },
    period: { from: '2020-01-01', to: '2025-12-31' },
    capital: { initialCash: 10_000_000, currency: 'KRW' },
    execution: {
      fillTiming: 'NEXT_BAR_OPEN',
      commissionProfileId: 'kr-default',
      slippageProfileId: 'kr-default',
    },
    risk: { maxPositions: 20 },
  };
}

/**
 * 유니버스 상한 (랭킹 전략용 확대). 스펙 2026-08-05 이후로는 종목 배열이 아니라
 * `universeRule.topN` 이 이 상한을 진다 — `MAX_UNIVERSE_SYMBOLS` 는 여전히 같은 상수다
 * (universe-rule.ts 참고).
 */
describe('유니버스 상한 (universeRule.topN)', () => {
  function requestWithTopN(topN: number): Record<string, unknown> {
    return {
      ...baseRequest(),
      strategyId: 'cross-sectional-momentum',
      universeRule: { markets: ['KOSPI'], topN, sortKey: 'MKTCAP' },
    };
  }

  it(`상한(${MAX_UNIVERSE_SYMBOLS})은 받는다`, () => {
    expect(backtestRequestSchema.safeParse(requestWithTopN(MAX_UNIVERSE_SYMBOLS)).success).toBe(true);
  });

  it('상한을 하나라도 넘으면 거부한다', () => {
    expect(backtestRequestSchema.safeParse(requestWithTopN(MAX_UNIVERSE_SYMBOLS + 1)).success).toBe(false);
  });

  it('하한 경계 — 1은 받고 0은 거부한다', () => {
    expect(backtestRequestSchema.safeParse(requestWithTopN(1)).success).toBe(true);
    expect(backtestRequestSchema.safeParse(requestWithTopN(0)).success).toBe(false);
  });
});

/**
 * universeRule (스펙 2026-08-05) — datasetId/universeSnapshotId/universe 를 대신한다.
 * markets 는 워커의 단일 시장 제약으로 정확히 1개여야 한다(universe-rule.ts).
 */
describe('universeRule', () => {
  it('universeRule 이 없으면 거부한다', () => {
    const { universeRule: _drop, ...rest } = baseRequest();
    expect(backtestRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('markets 가 2개면 거부한다 — 워커가 단일 시장만 다룬다', () => {
    const result = backtestRequestSchema.safeParse({
      ...baseRequest(),
      universeRule: { markets: ['KOSPI', 'KOSDAQ'], topN: 50, sortKey: 'MKTCAP' },
    });
    expect(result.success).toBe(false);
  });

  it('markets 가 0개면 거부한다', () => {
    const result = backtestRequestSchema.safeParse({
      ...baseRequest(),
      universeRule: { markets: [], topN: 50, sortKey: 'MKTCAP' },
    });
    expect(result.success).toBe(false);
  });

  it('정상 유니버스 규칙은 그대로 파싱된다', () => {
    const result = backtestRequestSchema.safeParse(baseRequest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.universeRule).toEqual({ markets: ['KOSPI'], topN: 50, sortKey: 'MKTCAP' });
    }
  });

  /**
   * 옛 필드가 있던 시절의 저장된 요청(복제·재실행)도 파싱은 돼야 한다 — z.object 는
   * 모르는 키를 버린다. 다만 universeRule 자체가 없으면 여전히 거부한다(위 테스트).
   */
  it('옛 datasetId/universeSnapshotId/universe 필드는 조용히 무시하고 파싱한다', () => {
    const result = backtestRequestSchema.safeParse({
      ...baseRequest(),
      datasetId: 'ds-1',
      universeSnapshotId: 'usn_1',
      universe: { type: 'SYMBOLS', symbols: ['005930'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).datasetId).toBeUndefined();
      expect((result.data as Record<string, unknown>).universeSnapshotId).toBeUndefined();
      expect((result.data as Record<string, unknown>).universe).toBeUndefined();
    }
  });
});
