import { describe, expect, it } from 'vitest';
import {
  blockingFinancialGapExamples,
  financialCoverageGapMessage,
  findFinancialCoverageGap,
} from '../../src/runtime/modules/backtest/application/backtest-financial-coverage.js';
import { StrategyRegistry } from '../../src/runtime/modules/strategy/application/strategy-registry.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';

const period: BacktestRequest['period'] = { from: '2025-01-02', to: '2025-12-31' };
const universeRule: BacktestRequest['universeRule'] = {
  markets: ['KOSPI'],
  stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 2 }],
  rebalanceInterval: { unit: 'MONTH', value: 1 },
};
const request: Pick<BacktestRequest, 'period' | 'universeRule'> = { period, universeRule };
const registry = new StrategyRegistry();

function coverage(
  entries: Readonly<Record<string, readonly number[]>>,
  blocking: Readonly<Record<string, readonly number[]>> = {},
) {
  return {
    getCoverageState: (codes?: readonly string[]) => new Map(
      Object.entries(entries)
        .filter(([code]) => codes === undefined || codes.includes(code))
        .map(([code, years]) => [code, {
          verifiedYears: years,
          blockingGapYears: blocking[code] ?? [],
          blockingGapDetails: (blocking[code] ?? []).map((year) => ({
            year, examples: [`${year}Q1: 파서 실패`],
          })),
        }]),
    ),
  };
}

describe('findFinancialCoverageGap', () => {
  it('lookback을 포함한 필수 연도를 최종 유니버스 모든 종목에 요구한다', () => {
    const strategy = registry.get('value-quality-rank')!;
    const gap = findFinancialCoverageGap({
      request,
      strategy,
      symbols: ['005930', '000660'],
      coverage: coverage({
        '005930': [2024, 2025],
        '000660': [2025],
      }),
    });

    expect(gap).toEqual({
      kind: 'MISSING_OR_CORRUPT',
      fromYear: 2024,
      toYear: 2025,
      missingSymbols: ['000660'],
    });
    expect(financialCoverageGapMessage(gap!)).toContain('000660');
    expect(financialCoverageGapMessage(gap!)).toContain('2024~2025년');
  });

  it('모든 종목의 필수 연도가 완전하면 실제 fact 행 수와 무관하게 통과한다', () => {
    expect(findFinancialCoverageGap({
      request,
      strategy: registry.get('value-quality-rank')!,
      symbols: ['005930', '000660'],
      coverage: coverage({
        '005930': [2023, 2024, 2025, 2026],
        '000660': [2024, 2025],
      }),
    })).toBeNull();
  });

  it('재무를 요구하지 않는 전략은 coverage가 없어도 통과한다', () => {
    expect(findFinancialCoverageGap({
      request,
      strategy: registry.get('range-breakout')!,
      symbols: ['005930'],
      coverage: coverage({}),
    })).toBeNull();
  });

  it('재무 전략이 lookback을 생략하면 요청 기간 연도만 요구한다', () => {
    const base = registry.get('range-breakout')!;
    expect(findFinancialCoverageGap({
      request,
      strategy: { ...base, requiresFundamentals: true },
      symbols: ['005930'],
      coverage: coverage({ '005930': [2024] }),
    })).toEqual({
      kind: 'MISSING_OR_CORRUPT',
      fromYear: 2025,
      toYear: 2025,
      missingSymbols: ['005930'],
    });
  });

  it('lookback만 선언한 미래 전략도 preparation plan과 같이 coverage를 요구한다', () => {
    const base = registry.get('range-breakout')!;
    expect(findFinancialCoverageGap({
      request,
      strategy: {
        ...base,
        dataRequirements: {
          ...base.dataRequirements,
          fundamentalLookbackQuarters: 4,
        },
      },
      symbols: ['005930'],
      coverage: coverage({ '005930': [2025] }),
    })).toEqual({
      kind: 'MISSING_OR_CORRUPT',
      fromYear: 2024,
      toYear: 2025,
      missingSymbols: ['005930'],
    });
  });

  it('재무 전략의 PER/ROE 유니버스 lookback도 준비 plan과 같은 범위로 검증한다', () => {
    const base = registry.get('range-breakout')!;
    expect(findFinancialCoverageGap({
      request: {
        period,
        universeRule: {
          ...universeRule,
          stages: [{ criterion: 'PER', direction: 'LOW', limit: 2 }],
        },
      },
      strategy: { ...base, requiresFundamentals: true },
      symbols: ['005930'],
      coverage: coverage({ '005930': [2025] }),
    })).toEqual({
      kind: 'MISSING_OR_CORRUPT',
      fromYear: 2024,
      toYear: 2025,
      missingSymbols: ['005930'],
    });
  });

  it('검증된 연도라도 blocking DART gap이 있으면 실행을 막는다', () => {
    const gap = findFinancialCoverageGap({
      request,
      strategy: registry.get('value-quality-rank')!,
      symbols: ['005930', '000660'],
      coverage: coverage(
        { '005930': [2024, 2025], '000660': [2024, 2025] },
        { '000660': [2024] },
      ),
    });

    expect(gap).toEqual({
      kind: 'BLOCKING_INGESTION_GAP',
      fromYear: 2024,
      toYear: 2025,
      affected: [{
        symbol: '000660', years: [2024], examples: ['2024Q1: 파서 실패'],
      }],
    });
    expect(financialCoverageGapMessage(gap!)).toContain('원천·파서 gap');
  });

  it('전략 계정과 종목의 실제 편입 기간으로 blocking gap을 제한한다', () => {
    const source = {
      getCoverageState: () => new Map([['005930', {
        verifiedYears: [2023, 2024, 2025], blockingGapYears: [2025],
        blockingGapDetails: [{ year: 2025, examples: [], gaps: [{
          symbol: '005930', periodKey: '2025Q1', reason: '순이익 충돌',
          severity: 'BLOCKING' as const, kind: 'CONFLICT' as const, field: 'NET_INCOME' as const,
          asOfTsMs: Date.parse('2025-04-01T09:00:00Z'),
        }] }],
      }]]),
    };
    const input = { request, strategy: registry.get('low-per-high-roe-rank')!, symbols: ['005930'], coverage: source };
    expect(findFinancialCoverageGap({ ...input, schedule: [
      { rebalanceDate: '2025-01-02', symbols: ['005930'] },
      { rebalanceDate: '2025-03-01', symbols: [] },
    ] })).toBeNull();
    expect(findFinancialCoverageGap(input)?.kind).toBe('BLOCKING_INGESTION_GAP');
    expect(findFinancialCoverageGap({ ...input, strategy: registry.get('earnings-acceleration-rank')! })).toBeNull();
  });

  it('필드가 지정된 정상 결측·미사용 계정·미래 공시는 무시하고 사용 계정 오류와 미분류 결손은 막는다', () => {
    const details = [{ year: 2025, examples: [], gaps: [
      { symbol: '005930', periodKey: '2025Q1', reason: 'TTM 결측', severity: 'BLOCKING' as const, kind: 'MISSING' as const, field: 'NET_INCOME' as const },
      { symbol: '005930', periodKey: '2025Q1', reason: '주식수 파싱 실패', severity: 'BLOCKING' as const, kind: 'INVALID' as const, field: 'SHARES_OUTSTANDING' as const },
      { symbol: '005930', periodKey: '2025Q2', reason: '미래 순이익 충돌', severity: 'BLOCKING' as const, kind: 'CONFLICT' as const, field: 'NET_INCOME' as const, asOfTsMs: 2_000 },
      { symbol: '005930', periodKey: '2025Q3', reason: '순이익 파싱 실패', severity: 'BLOCKING' as const, kind: 'INVALID' as const, field: 'NET_INCOME' as const, asOfTsMs: 500 },
      { symbol: '005930', periodKey: '2025Q3', reason: '자본총계 충돌', severity: 'BLOCKING' as const, kind: 'CONFLICT' as const, field: 'TOTAL_EQUITY' as const, asOfTsMs: 600 },
      { symbol: '005930', periodKey: '2025Q4', reason: '필드 미분류 결손', severity: 'BLOCKING' as const, kind: 'MISSING' as const },
    ] }];
    expect(blockingFinancialGapExamples(details, {
      fields: ['NET_INCOME', 'TOTAL_EQUITY'], fromYear: 2025, toYear: 2025, asOfMaxTsMs: 1_000,
    })).toEqual(['2025Q3: 순이익 파싱 실패', '2025Q3: 자본총계 충돌', '2025Q4: 필드 미분류 결손']);
    expect(blockingFinancialGapExamples([{ year: 2025, examples: ['legacy 원인'] }], {
      fields: ['NET_INCOME'], fromYear: 2025, toYear: 2025, asOfMaxTsMs: 1_000,
    })).toEqual(['legacy 원인']);
  });
});
