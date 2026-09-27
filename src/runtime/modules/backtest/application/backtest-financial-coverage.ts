import type { BacktestRequest } from "../../../../shared/schemas/backtest-request.js";
import type {
  FactCoverageStore,
  FinancialCoverageState,
} from "../../facts/application/fact-coverage-store.js";
import type { FundamentalField } from "../../facts/domain/fact.js";
import { addCalendarDays, kstEndOfDayMs } from "../../market-data/domain/kst-date.js";
import { derivePreparationFactYearRange } from "../../market-data/domain/fact-year-range.js";
import {
  strategyRequiresFinancialData,
  type AnyTradingStrategy,
} from "../../strategy/domain/strategy.js";

/** 미사용 계정과 정상적인 PIT 결측은 제외하고, 실제 사용 가능한 시점의 오류만 남긴다. */
export function blockingFinancialGapExamples(
  details: FinancialCoverageState["blockingGapDetails"],
  input: {
    readonly fields?: readonly FundamentalField[];
    readonly asOfMaxTsMs: number;
    readonly fromYear: number;
    readonly toYear: number;
  },
): string[] {
  const fields = input.fields === undefined ? null : new Set(input.fields);
  return details
    .filter((detail) => detail.year >= input.fromYear && detail.year <= input.toYear)
    .flatMap((detail) => {
      if (detail.gaps === undefined) {
        return detail.examples.length > 0
          ? detail.examples
          : ["계정·공시 시점을 확인할 수 없는 재무 입력 오류"];
      }
      return detail.gaps.filter((gap) =>
        !(fields !== null && gap.field !== undefined && gap.kind === "MISSING") &&
        !(fields !== null && gap.field !== undefined && !fields.has(gap.field)) &&
        !(gap.asOfTsMs !== undefined && gap.asOfTsMs > input.asOfMaxTsMs),
      ).map((gap) => `${gap.periodKey}: ${gap.reason}`);
    });
}

export type FinancialCoverageGap =
  | {
      readonly kind: "MISSING_OR_CORRUPT";
      readonly fromYear: number;
      readonly toYear: number;
      readonly missingSymbols: readonly string[];
    }
  | {
      readonly kind: "BLOCKING_INGESTION_GAP";
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
  readonly request: Pick<BacktestRequest, "period" | "universeRule">;
  readonly strategy: AnyTradingStrategy;
  readonly symbols: readonly string[];
  readonly coverage: Pick<FactCoverageStore, "getCoverageState">;
  readonly schedule?: readonly {
    readonly rebalanceDate: string;
    readonly symbols: readonly string[];
  }[];
}): FinancialCoverageGap | null {
  if (
    !strategyRequiresFinancialData(input.strategy) ||
    input.symbols.length === 0
  )
    return null;

  const universeLookbackQuarters = input.request.universeRule.stages.some(
    (stage) => stage.criterion === "PER" || stage.criterion === "ROE",
  )
    ? 4
    : 0;
  const lookbackQuarters = Math.max(
    universeLookbackQuarters,
    input.strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0,
  );
  const { fromYear, toYear } = derivePreparationFactYearRange(
    input.request.period,
    lookbackQuarters,
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
    return { kind: "MISSING_OR_CORRUPT", fromYear, toYear, missingSymbols };
  }
  const fields = input.strategy.dataRequirements?.fundamentalFields;
  const schedule = input.schedule === undefined ? null : [...input.schedule].sort(
    (left, right) => left.rebalanceDate.localeCompare(right.rebalanceDate),
  );
  const affected = symbols.flatMap((symbol) => {
    const state = stateBySymbol.get(symbol);
    const blocking = new Set(state?.blockingGapYears ?? []);
    const years = requiredYears.filter((year) => blocking.has(year));
    if (years.length === 0) return [];
    const windows = schedule === null ? [input.request.period] : schedule.flatMap((entry, index) => {
      if (!entry.symbols.includes(symbol)) return [];
      const nextDate = schedule[index + 1]?.rebalanceDate;
      const end = nextDate === undefined ? input.request.period.to : addCalendarDays(nextDate, -1);
      const from = entry.rebalanceDate < input.request.period.from ? input.request.period.from : entry.rebalanceDate;
      const to = end > input.request.period.to ? input.request.period.to : end;
      return to < from ? [] : [{ from, to }];
    });
    const details = state?.blockingGapDetails ?? [];
    const affectedYears = new Set<number>();
    const examples = new Set<string>();
    for (const window of windows) {
      const range = derivePreparationFactYearRange(window, lookbackQuarters);
      for (const year of years) {
        if (year < range.fromYear || year > range.toYear) continue;
        const yearDetails = details.filter((detail) => detail.year === year);
        const yearExamples = yearDetails.length === 0
          ? ["상세 원인을 확인할 수 없는 재무 입력 오류"]
          : blockingFinancialGapExamples(yearDetails, {
            fields, ...range, asOfMaxTsMs: kstEndOfDayMs(window.to),
          });
        if (yearExamples.length === 0) continue;
        affectedYears.add(year);
        for (const example of yearExamples) examples.add(example);
      }
    }
    return examples.size === 0 ? [] : [{
      symbol, years: [...affectedYears].sort((left, right) => left - right),
      examples: [...examples],
    }];
  });
  return affected.length === 0
    ? null
    : { kind: "BLOCKING_INGESTION_GAP", fromYear, toYear, affected };
}

export function financialCoverageGapMessage(gap: FinancialCoverageGap): string {
  const years =
    gap.fromYear === gap.toYear
      ? `${gap.fromYear}년`
      : `${gap.fromYear}~${gap.toYear}년`;
  if (gap.kind === "BLOCKING_INGESTION_GAP") {
    const affected = gap.affected
      .map(({ symbol, years: gapYears }) => `${symbol}(${gapYears.join(", ")})`)
      .join(", ");
    const examples = [
      ...new Set(gap.affected.flatMap((item) => item.examples)),
    ].slice(0, 3);
    return (
      `DART 재무 수집 결과에 실행을 막는 원천·파서 gap이 남아 있습니다(필요 연도 ${years}): ` +
      `${affected}${examples.length > 0 ? ` — 원인 예: ${examples.join(" / ")}` : ""}. ` +
      "원천·파서 문제를 확인하고 해당 원문을 다시 수집·검증하거나 " +
      "유니버스·기간을 조정하세요."
    );
  }
  return (
    `재무 수집 coverage가 부족한 유니버스 종목이 있습니다(필요 연도 ${years}): ` +
    `${gap.missingSymbols.join(", ")} — 미리보기를 다시 실행해 데이터 준비를 완료하세요. ` +
    "DART 일일 한도로 대기 중이면 다음 날 자동으로 재개됩니다."
  );
}
