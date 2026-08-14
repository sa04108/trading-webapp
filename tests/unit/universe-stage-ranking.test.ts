import { describe, expect, it } from 'vitest';
import {
  rankUniverseStage,
  type UniverseStageValue,
} from '../../src/server/modules/backtest/application/universe-stage-ranking.js';
import type { UniverseCriterion, UniverseStage } from '../../src/shared/schemas/universe-rule.js';

const rows = (...values: Array<[string, number | bigint | null]>): UniverseStageValue[] =>
  values.map(([shortCode, value]) => ({
    shortCode,
    standardCode: `KR7${shortCode}`,
    value,
  }));

function stage(
  criterion: UniverseCriterion,
  limit: number,
  direction: 'HIGH' | 'LOW',
): UniverseStage {
  return criterion === 'DECLINE'
    ? { criterion, direction, limit, lookbackTradingDays: 20 }
    : { criterion, direction, limit };
}

describe('rankUniverseStage', () => {
  it.each([
    ['MARKET_CAP', 'HIGH', ['KR7000001', 'KR7000002']],
    ['MARKET_CAP', 'LOW', ['KR7000003', 'KR7000002']],
    ['VOLUME', 'HIGH', ['KR7000001', 'KR7000002']],
    ['VOLUME', 'LOW', ['KR7000003', 'KR7000002']],
    ['TRADING_VALUE', 'HIGH', ['KR7000001', 'KR7000002']],
    ['TRADING_VALUE', 'LOW', ['KR7000003', 'KR7000002']],
    ['PER', 'HIGH', ['KR7000001', 'KR7000002']],
    ['PER', 'LOW', ['KR7000003', 'KR7000002']],
    ['DECLINE', 'HIGH', ['KR7000001', 'KR7000002']],
    ['DECLINE', 'LOW', ['KR7000003', 'KR7000002']],
  ] as const)('%s %s 방향으로 정렬한다', (criterion, direction, expected) => {
    const input = rows(['000003', 10], ['000001', 30], ['000002', 20]);
    expect(rankUniverseStage(stage(criterion, 2, direction), input)).toMatchObject({
      selectedCodes: expected,
      diagnostic: { criterion, direction },
    });
  });

  it('거래대금 bigint는 HIGH 방향에서도 정밀도를 잃지 않는다', () => {
    const input = rows(
      ['000003', 9_007_199_254_740_993n],
      ['000001', 9_007_199_254_740_995n],
      ['000002', 9_007_199_254_740_994n],
    );
    expect(rankUniverseStage(stage('TRADING_VALUE', 2, 'HIGH'), input).selectedCodes)
      .toEqual(['KR7000001', 'KR7000002']);
  });

  it('동률이면 모든 기준에서 단축코드 오름차순으로 결정한다', () => {
    for (const criterion of ['MARKET_CAP', 'VOLUME', 'TRADING_VALUE', 'PER', 'DECLINE'] as const) {
      const value = criterion === 'MARKET_CAP' || criterion === 'TRADING_VALUE' ? 10n : 10;
      expect(rankUniverseStage(stage(criterion, 3, 'HIGH'), rows(
        ['000003', value], ['000001', value], ['000002', value],
      )).selectedCodes).toEqual(['KR7000001', 'KR7000002', 'KR7000003']);
    }
  });

  it('결측과 비유한 PER을 제외하고 단계 진단 수를 정확히 센다', () => {
    const result = rankUniverseStage(stage('PER', 2, 'LOW'), rows(
      ['000001', 5], ['000002', null], ['000003', Number.NaN], ['000004', 7],
    ));

    expect(result.selectedCodes).toEqual(['KR7000001', 'KR7000004']);
    expect(result.diagnostic).toEqual({
      criterion: 'PER',
      direction: 'LOW',
      inputCount: 4,
      eligibleCount: 2,
      selectedCount: 2,
      excludedMissingCount: 2,
    });
  });

  it('limit보다 적은 eligible만 있으면 실제 selectedCount를 보고한다', () => {
    const result = rankUniverseStage(stage('MARKET_CAP', 3, 'HIGH'), rows(
      ['000001', 5n], ['000002', null],
    ));
    expect(result.diagnostic).toMatchObject({
      inputCount: 2,
      eligibleCount: 1,
      selectedCount: 1,
      excludedMissingCount: 1,
    });
  });
});
