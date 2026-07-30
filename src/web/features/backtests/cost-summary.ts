import { formatKrw } from '../../lib/format.js';
import type { BacktestMetrics } from './types.js';

/**
 * 총 비용 카드 문자열 (설계 2026-07-30-backtest-result-display-design.md §1).
 * 슬리피지 분모가 초기자본인 이유: totalReturnPct 와 같은 분모라
 * "수익률에서 몇 %p 깎였나" 를 직접 비교할 수 있다.
 */
export function costSummary(metrics: BacktestMetrics): {
  totalText: string;
  detailText: string;
} {
  // 항목별로 개별 반올림한 후 합산하여 총합과 항목 합계의 차이를 제거한다
  const roundedCommission = Math.round(metrics.totalCommission);
  const roundedTax = Math.round(metrics.totalTax);
  const roundedSlippage = Math.round(metrics.totalSlippage);
  const total = roundedCommission + roundedTax + roundedSlippage;

  const slippagePct =
    metrics.initialCash > 0 ? (metrics.totalSlippage / metrics.initialCash) * 100 : 0;
  return {
    totalText: formatKrw(total),
    detailText:
      `수수료 ${formatKrw(metrics.totalCommission)} · 세금 ${formatKrw(metrics.totalTax)}` +
      ` · 슬리피지 ${formatKrw(metrics.totalSlippage)} (초기자본의 ${slippagePct.toFixed(2)}%)`,
  };
}
