import { describe, expect, it } from 'vitest';
import {
  sumExcludedNonTrading,
  UniverseRuleResolver,
  type UniverseScheduleEntry,
} from '../../src/server/modules/backtest/application/universe-rule-resolver.js';

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
  });

  it('조회 하한을 첫 리밸런스 날짜보다 31일 앞으로 잡는다', async () => {
    // 리밸런스 날짜가 휴장이면 effectiveTradingDate 가 그보다 앞선 거래일이 된다.
    // 하한을 리밸런스 날짜 그대로 두면 그 거래일의 거래불가 행을 못 읽어 제외가
    // 조용히 꺼진다 — 결과만 보고는 구별되지 않는 회귀다.
    const nonTradingCalls: { from: string; to: string }[] = [];
    const master = {
      isCovered: () => true,
      effectiveTradingDateWithinCoverage: (date: string) => date,
      getUniverseAsOf: () => new Map(),
      getMarketCapsAt: async () => new Map(),
      nonTradingDaysBetween: (from: string, to: string) => {
        nonTradingCalls.push({ from, to });
        return [];
      },
    };
    const resolver = new UniverseRuleResolver({
      symbolMaster: master as never,
      logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
    });

    await resolver.resolve(
      { markets: ['KOSDAQ'], topN: 1, sortKey: 'MKTCAP' },
      ['2022-02-15', '2022-03-15'],
    );

    // 2022-02-15 의 31일 전은 2022-01-15 다. 상한은 마지막 리밸런스 날짜 그대로다.
    expect(nonTradingCalls).toEqual([{ from: '2022-01-15', to: '2022-03-15' }]);
  });
});

describe('sumExcludedNonTrading', () => {
  // 워커는 resolved 전체가 아니라 job 에 저장된 schedule(UniverseScheduleEntry[])만
  // 받는다 — resolve() 와 워커가 같은 합산 로직을 쓰게 해서, 리밸런스가 여러 번인
  // 실행에서도 두 곳의 합계가 갈라지지 않게 한다.
  it('일정 전체에서 제외 건수를 더한다 (중복 포함)', () => {
    const schedule: UniverseScheduleEntry[] = [
      { rebalanceDate: '2026-01-02', effectiveTradingDate: '2026-01-02', symbols: ['005930'], excludedNonTradingCount: 2 },
      { rebalanceDate: '2026-04-01', effectiveTradingDate: '2026-04-01', symbols: ['005930'], excludedNonTradingCount: 0 },
      { rebalanceDate: '2026-07-01', effectiveTradingDate: '2026-07-01', symbols: ['005930'], excludedNonTradingCount: 1 },
    ];
    expect(sumExcludedNonTrading(schedule)).toBe(3);
  });

  it('빈 일정은 0이다', () => {
    expect(sumExcludedNonTrading([])).toBe(0);
  });
});
