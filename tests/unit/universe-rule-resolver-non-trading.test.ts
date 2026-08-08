import { describe, expect, it } from 'vitest';
import { UniverseRuleResolver } from '../../src/server/modules/backtest/application/universe-rule-resolver.js';

describe('UniverseRuleResolver 거래불가 제외', () => {
  it('기준일에 거래불가인 종목은 시총이 커도 후보에서 빠진다', async () => {
    const master = {
      isCovered: () => true,
      effectiveTradingDateWithinCoverage: (date: string) => date,
      getUniverseAsOf: () => new Map([
        ['KR7215600008', { standardCode: 'KR7215600008', shortCode: '215600', name: '신라젠', market: 'KOSDAQ', sharesOutstanding: '1', instrumentType: 'COMMON_STOCK', listedDate: null }],
        ['KR7048260006', { standardCode: 'KR7048260006', shortCode: '048260', name: '오스템임플란트', market: 'KOSDAQ', sharesOutstanding: '1', instrumentType: 'COMMON_STOCK', listedDate: null }],
      ]),
      // 신라젠이 시총 1위다 — 제외가 없으면 topN=1 에서 신라젠이 뽑힌다.
      // 정지 중에도 MKTCAP 이 갱신된다는 실측 사실이 이 테스트가 존재하는 이유다.
      getMarketCapsAt: async () => new Map([
        ['KR7215600008', '2038571815900'],
        ['KR7048260006', '1244692212500'],
      ]),
      nonTradingDaysBetween: () => [
        { date: '2022-02-15', shortCode: '215600', lastClose: 12_100 },
      ],
    };
    const resolver = new UniverseRuleResolver({
      symbolMaster: master as never,
      logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
    });

    const resolved = await resolver.resolve(
      { markets: ['KOSDAQ'], topN: 1, sortKey: 'MKTCAP' },
      ['2022-02-15'],
    );

    expect(resolved.schedule[0]?.symbols).toEqual(['048260']);
    expect(resolved.schedule[0]?.excludedNonTradingCount).toBe(1);
    expect(resolved.excludedNonTradingTotal).toBe(1);
  });
});
