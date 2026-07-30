import { describe, expect, it } from 'vitest';
import { costSummary } from '../../src/web/features/backtests/cost-summary.js';
import type { BacktestMetrics } from '../../src/web/features/backtests/types.js';

function metricsWith(costs: {
  totalCommission: number;
  totalTax: number;
  totalSlippage: number;
  initialCash: number;
}): BacktestMetrics {
  return {
    initialCash: costs.initialCash,
    finalEquity: costs.initialCash,
    totalReturnPct: 0,
    cagrPct: null,
    maxDrawdownPct: 0,
    maxDrawdownDurationMs: 0,
    volatilityPct: null,
    sharpe: null,
    sortino: null,
    calmar: null,
    winRate: null,
    profitFactor: null,
    avgWin: null,
    avgLoss: null,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    tradeCount: 0,
    avgHoldingTimeMs: null,
    maxConcurrentPositions: 0,
    totalCommission: costs.totalCommission,
    totalTax: costs.totalTax,
    totalSlippage: costs.totalSlippage,
  };
}

describe('costSummary', () => {
  it('세 비용의 합계와 항목별 내역을 만든다', () => {
    const result = costSummary(
      metricsWith({
        totalCommission: 152_300,
        totalTax: 121_800,
        totalSlippage: 113_320,
        initialCash: 10_000_000,
      }),
    );
    expect(result.totalText).toBe('387,420원');
    expect(result.detailText).toBe(
      '수수료 152,300원 · 세금 121,800원 · 슬리피지 113,320원 (초기자본의 1.13%)',
    );
  });

  it('zero-cost 프로파일이면 0원과 0.00% 를 그대로 보여준다', () => {
    const result = costSummary(
      metricsWith({ totalCommission: 0, totalTax: 0, totalSlippage: 0, initialCash: 10_000_000 }),
    );
    expect(result.totalText).toBe('0원');
    expect(result.detailText).toBe('수수료 0원 · 세금 0원 · 슬리피지 0원 (초기자본의 0.00%)');
  });

  it('슬리피지 퍼센트는 소수 둘째 자리로 반올림한다', () => {
    const result = costSummary(
      metricsWith({ totalCommission: 0, totalTax: 0, totalSlippage: 12_345, initialCash: 10_000_000 }),
    );
    expect(result.detailText).toContain('(초기자본의 0.12%)');
  });

  it('초기자본이 0이면 슬리피지 퍼센트가 0.00%이다', () => {
    const result = costSummary(
      metricsWith({ totalCommission: 1_000, totalTax: 500, totalSlippage: 300, initialCash: 0 }),
    );
    expect(result.detailText).toContain('(초기자본의 0.00%)');
  });

  it('소수점 입력값이 있을 때 총합이 항목별 합계와 일치한다', () => {
    const result = costSummary(
      metricsWith({
        totalCommission: 100.4,
        totalTax: 100.4,
        totalSlippage: 100.4,
        initialCash: 10_000_000,
      }),
    );
    // 항목별 반올림: 100 + 100 + 100 = 300
    expect(result.totalText).toBe('300원');
    // 항목별 표시는 각각 반올림됨
    expect(result.detailText).toContain('수수료 100원');
    expect(result.detailText).toContain('세금 100원');
    expect(result.detailText).toContain('슬리피지 100원');
  });
});
