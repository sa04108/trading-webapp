import { describe, expect, it } from 'vitest';
import {
  financialCoverageGapMessage,
  findFinancialCoverageGap,
} from '../../src/server/modules/backtest/application/backtest-financial-coverage.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
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
});
