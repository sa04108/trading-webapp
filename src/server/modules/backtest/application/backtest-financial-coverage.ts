import type { BacktestRequest } from '../../../../shared/schemas/backtest-request.js';
import type { FactCoverageStore } from '../../facts/application/fact-coverage-store.js';
import { derivePreparationFactYearRange } from '../../market-data/domain/fact-year-range.js';
import {
  strategyRequiresFinancialData,
  type AnyTradingStrategy,
} from '../../strategy/domain/strategy.js';

export type FinancialCoverageGap =
  | {
      readonly kind: 'MISSING_OR_CORRUPT';
      readonly fromYear: number;
      readonly toYear: number;
      readonly missingSymbols: readonly string[];
    }
  | {
      readonly kind: 'BLOCKING_INGESTION_GAP';
      readonly fromYear: number;
      readonly toYear: number;
      readonly affected: readonly {
        readonly symbol: string;
        readonly years: readonly number[];
        readonly examples: readonly string[];
      }[];
    };

/**
 * 재무 전략의 실행 계획과 같은 lookback 연도를 최종 유니버스 전 종목에
 * 요구한다. 실제 fact 0건은 DART가 완전히 조회했지만 공시가 없던 정상 상태일
 * 수 있으므로 coverage 결측과 구분한다.
 */
export function findFinancialCoverageGap(input: {
  readonly request: Pick<BacktestRequest, 'period' | 'universeRule'>;
  readonly strategy: AnyTradingStrategy;
  readonly symbols: readonly string[];
  readonly coverage: Pick<FactCoverageStore, 'getCoverageState'>;
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

  const stateBySymbol = input.coverage.getCoverageState(input.symbols);
  const symbols = [...new Set(input.symbols)].sort();
  const missingSymbols = symbols.filter((symbol) => {
    const covered = new Set(stateBySymbol.get(symbol)?.verifiedYears ?? []);
    return requiredYears.some((year) => !covered.has(year));
  });
  if (missingSymbols.length > 0) {
    return { kind: 'MISSING_OR_CORRUPT', fromYear, toYear, missingSymbols };
  }
  const affected = symbols.flatMap((symbol) => {
    const state = stateBySymbol.get(symbol);
    const blocking = new Set(state?.blockingGapYears ?? []);
    const years = requiredYears.filter((year) => blocking.has(year));
    const examples = (state?.blockingGapDetails ?? [])
      .filter((detail) => years.includes(detail.year))
      .flatMap((detail) => detail.examples);
    return years.length === 0 ? [] : [{ symbol, years, examples }];
  });
  return affected.length === 0
    ? null
    : { kind: 'BLOCKING_INGESTION_GAP', fromYear, toYear, affected };
}

export function financialCoverageGapMessage(gap: FinancialCoverageGap): string {
  const years = gap.fromYear === gap.toYear
    ? `${gap.fromYear}년`
    : `${gap.fromYear}~${gap.toYear}년`;
  if (gap.kind === 'BLOCKING_INGESTION_GAP') {
    const affected = gap.affected
      .map(({ symbol, years: gapYears }) => `${symbol}(${gapYears.join(', ')})`)
      .join(', ');
    const examples = [...new Set(gap.affected.flatMap((item) => item.examples))].slice(0, 3);
    return (
      `DART 재무 수집 결과에 실행을 막는 원천·파서 gap이 남아 있습니다(필요 연도 ${years}): `
      + `${affected}${examples.length > 0 ? ` — 원인 예: ${examples.join(' / ')}` : ''}. `
      + '원천·파서 문제를 수정하고 coverage protocol version을 갱신해 재수집하거나 '
      + '유니버스·기간을 조정하세요.'
    );
  }
  return (
    `재무 수집 coverage가 부족한 유니버스 종목이 있습니다(필요 연도 ${years}): `
    + `${gap.missingSymbols.join(', ')} — 미리보기를 다시 실행해 데이터 준비를 완료하세요. `
    + 'DART 일일 한도로 대기 중이면 다음 날 자동으로 재개됩니다.'
  );
}
