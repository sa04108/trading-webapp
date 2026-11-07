import type { SymbolMasterEntry } from "../../market-data/domain/symbol-master.js";
import { backtestDataExclusionKey } from "./backtest-data-exclusion.js";
import type { UniverseResolveAttempt } from "./universe-rule-resolver.js";

export function partitionRebalanceDates(
  dates: readonly string[],
  chunkSize = 6,
): string[][] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("분할 크기는 양의 정수여야 합니다.");
  }
  const parts: string[][] = [];
  for (let offset = 0; offset < dates.length; offset += chunkSize) {
    parts.push(dates.slice(offset, offset + chunkSize));
  }
  return parts;
}

type Part = { rebalanceDates: readonly string[]; result: UniverseResolveAttempt };
type Ready = Extract<UniverseResolveAttempt, { kind: "READY" }>;

export class UniverseResolutionAccumulator {
  private readonly expectedDates: readonly string[];
  private offset = 0;
  private readonly unionEntries = new Map<string, SymbolMasterEntry>();
  private schedule: Ready["schedule"][number][] = [];
  private diagnostics: Ready["diagnostics"][number][] = [];
  private dataExclusions = new Map<string, Ready["dataExclusions"][number]>();
  private actionExclusions = new Map<string, Ready["corporateActionExclusions"][number]>();
  private hasNeeds = false;
  private candidateScopeKnown = true;
  private readonly factSymbols = new Set<string>();
  private readonly actionSymbols = new Set<string>();
  private readonly priceSymbols = new Set<string>();
  private readonly selectionMetricDates = new Set<string>();
  private priceRange: { from: string; to: string } | null = null;

  constructor(expectedDates: readonly string[]) {
    this.expectedDates = [...expectedDates];
    for (let i = 1; i < expectedDates.length; i += 1) {
      if (expectedDates[i - 1]! >= expectedDates[i]!) throw new Error("예상 리밸런스 일정이 정렬되어 있지 않습니다.");
    }
  }

  add(part: Part): void {
    if (part.rebalanceDates.length === 0 || part.rebalanceDates.some((date, i) => date !== this.expectedDates[this.offset + i])) {
      throw new Error("리밸런스 분할 범위가 올바르지 않습니다.");
    }
    const { result } = part;
    if (result.kind === "READY") {
      for (const rows of [result.schedule, result.diagnostics]) {
        if (rows.length !== part.rebalanceDates.length || rows.some((row, i) => row.rebalanceDate !== part.rebalanceDates[i])) {
          throw new Error("해소 결과가 할당된 리밸런스 날짜와 다릅니다.");
        }
      }
    }
    this.offset += part.rebalanceDates.length;
    for (const [key, entry] of result.unionEntries) if (!this.unionEntries.has(key)) this.unionEntries.set(key, entry);
    if (result.kind === "NEEDS_DATA") {
      if (!this.hasNeeds) {
        this.schedule = [];
        this.diagnostics = [];
        this.dataExclusions.clear();
        this.actionExclusions.clear();
      }
      this.hasNeeds = true;
      this.candidateScopeKnown &&= result.candidateScopeKnown;
      for (const key of ["factSymbols", "actionSymbols", "priceSymbols", "selectionMetricDates"] as const) {
        for (const value of result.needs[key]) this[key].add(value);
      }
      const range = result.needs.priceRange;
      if (range !== null) this.priceRange = this.priceRange === null ? { ...range } : {
        from: range.from < this.priceRange.from ? range.from : this.priceRange.from,
        to: range.to > this.priceRange.to ? range.to : this.priceRange.to,
      };
    } else if (!this.hasNeeds) {
      this.schedule.push(...result.schedule);
      this.diagnostics.push(...result.diagnostics);
      for (const item of result.dataExclusions) this.dataExclusions.set(backtestDataExclusionKey(item), item);
      for (const item of result.corporateActionExclusions) this.actionExclusions.set(`${item.symbol}\0${item.year}\0${item.periodKey}\0${item.reason}`, item);
    }
  }

  finish(): UniverseResolveAttempt {
    if (this.offset !== this.expectedDates.length) throw new Error("리밸런스 분할에 누락된 날짜가 있습니다.");
    if (this.hasNeeds) return {
      kind: "NEEDS_DATA", candidateScopeKnown: this.candidateScopeKnown, unionEntries: this.unionEntries,
      needs: { factSymbols: [...this.factSymbols].sort(), actionSymbols: [...this.actionSymbols].sort(),
        priceSymbols: [...this.priceSymbols].sort(), selectionMetricDates: [...this.selectionMetricDates].sort(), priceRange: this.priceRange },
    };
    return {
      kind: "READY", schedule: this.schedule, diagnostics: this.diagnostics, unionEntries: this.unionEntries,
      dataExclusions: [...this.dataExclusions.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.category.localeCompare(b.category) || a.periodKey.localeCompare(b.periodKey) || a.reason.localeCompare(b.reason)),
      corporateActionExclusions: [...this.actionExclusions.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.year - b.year || a.periodKey.localeCompare(b.periodKey) || a.reason.localeCompare(b.reason)),
    };
  }
}

export function mergeUniverseResolutions(parts: readonly Part[], expectedDates: readonly string[]): UniverseResolveAttempt {
  const indexes = new Map(expectedDates.map((date, index) => [date, index]));
  const ordered = [...parts].sort((a, b) =>
    (indexes.get(a.rebalanceDates[0] ?? "") ?? -1) - (indexes.get(b.rebalanceDates[0] ?? "") ?? -1),
  );
  const accumulator = new UniverseResolutionAccumulator(expectedDates);
  for (const part of ordered) accumulator.add(part);
  return accumulator.finish();
}
