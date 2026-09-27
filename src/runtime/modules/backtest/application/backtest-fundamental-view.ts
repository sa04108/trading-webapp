import type { Fact, FundamentalSnapshot } from "../../facts/domain/fact.js";
import { CORPORATE_ACTION_FIELD } from "../../facts/domain/fact.js";
import type { FactQuery } from "../../facts/application/ports.js";
import { PitFactView } from "../../facts/domain/pit-fact-view.js";

/** 한 종목씩 읽어 엔진에서 쓰는 재무 PIT 뷰를 제공한다. */
export class BacktestFundamentalView {
  private cachedSymbol: string | null = null;
  private cachedCutoff: number | null = null;
  private cachedSnapshot: FundamentalSnapshot | null = null;
  private hasCachedResult = false;

  constructor(
    private readonly readFacts: (query: FactQuery) => readonly Fact[],
    private readonly cutoffsBySymbol: ReadonlyMap<string, number>,
  ) {}

  fundamentals(symbol: string, tsMs: number): FundamentalSnapshot | null {
    const symbolCutoff = this.cutoffsBySymbol.get(symbol);
    if (symbolCutoff === undefined) return null;
    const cutoff = Math.min(tsMs, symbolCutoff);
    if (
      this.hasCachedResult &&
      this.cachedSymbol === symbol &&
      this.cachedCutoff === cutoff
    ) {
      return this.cachedSnapshot;
    }

    // 로드 전에 이전 결과 참조를 놓아 두 종목의 재무 이력이 함께 남지 않게 한다.
    this.cachedSymbol = null;
    this.cachedCutoff = null;
    this.cachedSnapshot = null;
    this.hasCachedResult = false;

    const facts = this.readFacts({
      scope: "SYMBOL",
      keys: [symbol],
      asOfMaxTsMs: cutoff,
    }).filter((fact) => fact.field !== CORPORATE_ACTION_FIELD);
    const view = new PitFactView(facts);
    view.advanceTo(cutoff);
    const snapshot = view.fundamentals(symbol);

    this.cachedSymbol = symbol;
    this.cachedCutoff = cutoff;
    this.cachedSnapshot = snapshot;
    this.hasCachedResult = true;
    return snapshot;
  }
}
