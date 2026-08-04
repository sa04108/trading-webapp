import { describe, expect, it } from 'vitest';
import {
  combineMarketSnapshots,
  selectionPayloadOf,
  UniverseJoinError,
} from '../../src/server/modules/market-data/domain/historical-universe.js';
import { UnknownKrxClassificationError } from '../../src/server/modules/market-data/domain/krx-filter-policy.js';
import type {
  KrxDailyTradeRow,
  KrxIssueBaseInfoRow,
  KrxMarket,
} from '../../src/server/modules/market-data/domain/krx-universe-types.js';

function baseRow(
  shortCode: string,
  overrides: Partial<KrxIssueBaseInfoRow> = {},
): KrxIssueBaseInfoRow {
  return {
    standardCode: `KR${shortCode}`,
    shortCode,
    name: `종목-${shortCode}`,
    listedDate: '2020-01-02',
    marketRaw: '유가증권시장',
    securityGroupRaw: '주권',
    sectionRaw: null,
    stockKindRaw: '보통주',
    ...overrides,
  };
}

function dailyRow(
  shortCode: string,
  marketCapRaw: string | null,
  name = `일별-${shortCode}`,
): KrxDailyTradeRow {
  return { shortCode, name, marketCapRaw };
}

function marketInput(
  market: KrxMarket,
  baseRows: readonly KrxIssueBaseInfoRow[],
  dailyRows: readonly KrxDailyTradeRow[],
) {
  return { market, baseRows, dailyRows };
}

const effectiveTradingDate = '2025-01-02';

describe('combineMarketSnapshots', () => {
  it('시가총액 내림차순과 단축코드 오름차순으로 정렬하고 알려진 종목에만 순위를 매긴다', () => {
    const result = combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [
        marketInput(
          'KOSPI',
          [baseRow('000500'), baseRow('000301'), baseRow('000300')],
          [dailyRow('000300', '300'), dailyRow('000500', '500'), dailyRow('000301', '300')],
        ),
      ],
    });

    expect(result.candidates.map(({ shortCode, marketCapKrw, rank }) => ({
      shortCode,
      marketCapKrw,
      rank,
    }))).toEqual([
      { shortCode: '000500', marketCapKrw: 500n, rank: 1 },
      { shortCode: '000300', marketCapKrw: 300n, rank: 2 },
      { shortCode: '000301', marketCapKrw: 300n, rank: 3 },
    ]);
  });

  it('일별 행이 없는 적격 종목을 0원이 아닌 모름으로 마지막에 둔다', () => {
    const result = combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [marketInput('KOSPI', [baseRow('000002'), baseRow('000001')], [dailyRow('000001', '0')])],
    });

    expect(result.candidates).toMatchObject([
      { shortCode: '000001', marketCapKrw: 0n, rank: 1 },
      { shortCode: '000002', marketCapKrw: null, rank: null },
    ]);
    expect(result.unknownMarketCapCount).toBe(1);
  });

  it('null 시가총액을 BigInt 0으로 바꾸지 않는다', () => {
    const result = combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [marketInput('KOSDAQ', [baseRow('100001')], [dailyRow('100001', null)])],
    });

    expect(result.candidates[0]).toMatchObject({ marketCapKrw: null, rank: null });
    expect(result.unknownMarketCapCount).toBe(1);
  });

  it('기본정보에 없는 일별 단축코드가 있으면 역조인 오류다', () => {
    expect(() => combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [marketInput('KOSDAQ', [], [dailyRow('999999', '1')])],
    })).toThrowError(UniverseJoinError);
  });

  it('시장 안에서 기본정보 단축코드가 중복되면 오류다', () => {
    expect(() => combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [marketInput('KOSPI', [baseRow('005930'), baseRow('005930')], [])],
    })).toThrowError(UniverseJoinError);
  });

  it('시장 안에서 일별 단축코드가 중복되면 오류다', () => {
    expect(() => combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [
        marketInput(
          'KOSPI',
          [baseRow('005930')],
          [dailyRow('005930', '2'), dailyRow('005930', '1')],
        ),
      ],
    })).toThrowError(UniverseJoinError);
  });

  it('제외 종목이어도 시장을 가로지른 표준코드 중복을 먼저 거부한다', () => {
    const duplicateStandardCode = 'KR-DUPLICATE';
    const excluded = { securityGroupRaw: 'ETF' } satisfies Partial<KrxIssueBaseInfoRow>;

    expect(() => combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [
        marketInput('KOSPI', [baseRow('100001', { ...excluded, standardCode: duplicateStandardCode })], []),
        marketInput('KOSDAQ', [baseRow('200001', { ...excluded, standardCode: duplicateStandardCode })], []),
      ],
    })).toThrowError(UniverseJoinError);
  });

  it('같은 시장 입력이 두 번 오면 덮어쓰거나 합치지 않는다', () => {
    expect(() => combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [marketInput('KOSPI', [], []), marketInput('KOSPI', [], [])],
    })).toThrowError(UniverseJoinError);
  });

  it('제외 사유를 집계하고 적격 수에는 보통주만 센다', () => {
    const result = combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [
        marketInput(
          'KOSPI',
          [
            baseRow('000001'),
            baseRow('000002', { stockKindRaw: '우선주' }),
            baseRow('000003', { securityGroupRaw: 'ETF' }),
          ],
          [dailyRow('000001', '10')],
        ),
      ],
    });

    expect(result.excludedByType).toEqual({ NON_STOCK_SECURITY: 1, PREFERRED_STOCK: 1 });
    expect(result.eligibleCount).toBe(1);
  });

  it('알 수 없는 KRX 분류 오류를 바꾸거나 삼키지 않고 전파한다', () => {
    expect(() => combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [
        marketInput('KOSPI', [baseRow('000001', { securityGroupRaw: '신종증권' })], []),
      ],
    })).toThrowError(UnknownKrxClassificationError);
  });

  it('두 시장의 기본정보 원시 행 수를 빈 시장까지 포함해 센다', () => {
    const result = combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [marketInput('KOSDAQ', [baseRow('100001'), baseRow('100002')], [])],
    });

    expect(result.rawCounts).toEqual({ KOSPI: 0, KOSDAQ: 2 });
  });

  it('시장·기본정보·일별 행 순서가 달라도 같은 결과와 canonical payload를 만든다', () => {
    const kospi = marketInput(
      'KOSPI',
      [baseRow('000002'), baseRow('000001')],
      [dailyRow('000002', '20'), dailyRow('000001', '10')],
    );
    const kosdaq = marketInput(
      'KOSDAQ',
      [baseRow('100002'), baseRow('100001')],
      [dailyRow('100002', null), dailyRow('100001', '30')],
    );
    const reversedKospi = marketInput('KOSPI', [...kospi.baseRows].reverse(), [...kospi.dailyRows].reverse());
    const reversedKosdaq = marketInput('KOSDAQ', [...kosdaq.baseRows].reverse(), [...kosdaq.dailyRows].reverse());

    const first = combineMarketSnapshots({ effectiveTradingDate, inputs: [kospi, kosdaq] });
    const second = combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [reversedKosdaq, reversedKospi],
    });

    expect(second).toEqual(first);
    expect(second.canonicalPayload).toBe(first.canonicalPayload);
  });

  it('시가총액이 1만 달라도 canonical payload가 달라진다', () => {
    const baseRows = [baseRow('000001')];
    const payload = (cap: string) => combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [marketInput('KOSPI', baseRows, [dailyRow('000001', cap)])],
    }).canonicalPayload;

    expect(payload('100')).not.toBe(payload('101'));
  });

  it('canonical payload에 날짜·정책·계약 버전과 후보의 정확한 값을 기록한다', () => {
    const result = combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [
        marketInput(
          'KOSPI',
          [baseRow('000001', { standardCode: 'KR-A', name: '기본정보 이름' }), baseRow('000002', { standardCode: 'KR-B' })],
          [dailyRow('000001', '123456789012345', '일별 이름은 쓰지 않음')],
        ),
      ],
    });

    expect(result).toMatchObject({
      effectiveTradingDate,
      filterPolicyVersion: 'krx-common-stock-v2',
      contractVersion: 'v1',
    });
    expect(result.candidates[0]?.name).toBe('기본정보 이름');
    expect(result.canonicalPayload).toBe([
      '2025-01-02|krx-common-stock-v2|v1',
      'KR-A|000001|KOSPI|123456789012345',
      'KR-B|000002|KOSPI|unknown',
    ].join('\n'));
  });

  it('정규화 경계에 잘못된 내부 시가총액이 오면 시장과 코드를 담아 명확히 실패한다', () => {
    expect(() => combineMarketSnapshots({
      effectiveTradingDate,
      inputs: [marketInput('KOSPI', [baseRow('005930')], [dailyRow('005930', '12.5')])],
    })).toThrowError(/KOSPI.*005930.*시가총액/);
  });

  it('조인 오류는 안정된 이름과 시장·코드 문맥을 담는다', () => {
    try {
      combineMarketSnapshots({
        effectiveTradingDate,
        inputs: [marketInput('KOSDAQ', [], [dailyRow('999999', '1')])],
      });
      throw new Error('조인 오류가 발생해야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(UniverseJoinError);
      expect(error).toMatchObject({ name: 'UniverseJoinError' });
      expect((error as Error).message).toMatch(/KOSDAQ.*999999/);
    }
  });
});

describe('selectionPayloadOf', () => {
  it('선택 순서와 무관하며 구성원이 달라지면 달라진다', () => {
    const canonicalPayload = 'canonical';

    expect(selectionPayloadOf(canonicalPayload, ['KR-B', 'KR-A'])).toBe(
      selectionPayloadOf(canonicalPayload, ['KR-A', 'KR-B']),
    );
    expect(selectionPayloadOf(canonicalPayload, ['KR-A'])).not.toBe(
      selectionPayloadOf(canonicalPayload, ['KR-B']),
    );
  });

  it('중복 선택 코드를 단일 선택과 구별해 보존한다', () => {
    expect(selectionPayloadOf('canonical', ['KR-A', 'KR-A'])).toBe(
      'canonical\n--selection--\nKR-A\nKR-A',
    );
    expect(selectionPayloadOf('canonical', ['KR-A', 'KR-A'])).not.toBe(
      selectionPayloadOf('canonical', ['KR-A']),
    );
  });
});
