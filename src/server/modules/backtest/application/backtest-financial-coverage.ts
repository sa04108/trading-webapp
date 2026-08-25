import type { BacktestRequest } from '../../../../shared/schemas/backtest-request.js';
import type { FactCoverageStore } from '../../facts/application/fact-coverage-store.js';
import { derivePreparationFactYearRange } from '../../market-data/domain/fact-year-range.js';
import {
  strategyRequiresFinancialData,
  type AnyTradingStrategy,
} from '../../strategy/domain/strategy.js';

export interface FinancialCoverageGap {
  readonly fromYear: number;
  readonly toYear: number;
  readonly missingSymbols: readonly string[];
}

/**
 * 재무 전략의 실행 계획과 같은 lookback 연도를 최종 유니버스 전 종목에
 * 요구한다. 실제 fact 0건은 DART가 완전히 조회했지만 공시가 없던 정상 상태일
 * 수 있으므로 coverage 결측과 구분한다.
 */
export function findFinancialCoverageGap(input: {
  readonly request: Pick<BacktestRequest, 'period' | 'universeRule'>;
  readonly strategy: AnyTradingStrategy;
  readonly symbols: readonly string[];
  readonly coverage: Pick<FactCoverageStore, 'getCoveredYears'>;
}): FinancialCoverageGap | null {
  if (!strategyRequiresFinancialData(input.strategy) || input.symbols.length === 0) return null;

  const universeLookbackQuarters = input.request.universeRule.stages.some(
    (stage) => stage.criterion === 'PER' || stage.criterion === 'ROE',
  ) ? 4 : 0;
  const { fromYear, toYear } = derivePreparationFactYearRange(
    input.request.period,
    Math.max(
      universeLookbackQuarters,
      input.strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0,
    ),
  );
  const requiredYears: number[] = [];
  for (let year = fromYear; year <= toYear; year += 1) requiredYears.push(year);

  const coveredBySymbol = input.coverage.getCoveredYears(input.symbols);
  const missingSymbols = [...new Set(input.symbols)].sort().filter((symbol) => {
    const covered = new Set(coveredBySymbol.get(symbol) ?? []);
    return requiredYears.some((year) => !covered.has(year));
  });
  return missingSymbols.length === 0 ? null : { fromYear, toYear, missingSymbols };
}

export function financialCoverageGapMessage(gap: FinancialCoverageGap): string {
  const years = gap.fromYear === gap.toYear
    ? `${gap.fromYear}년`
    : `${gap.fromYear}~${gap.toYear}년`;
  return (
    `재무 수집 coverage가 부족한 유니버스 종목이 있습니다(필요 연도 ${years}): `
    + `${gap.missingSymbols.join(', ')} — 미리보기를 다시 실행해 데이터 준비를 완료하세요. `
    + 'DART 일일 한도로 대기 중이면 다음 날 자동으로 재개됩니다.'
  );
}
