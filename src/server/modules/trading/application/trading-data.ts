import type { SymbolMasterEntry } from "../../../../runtime/modules/market-data/domain/symbol-master.js";
import type { MarketIndexRequirement } from "../../../../runtime/modules/market-data/domain/market-index.js";

export interface TradingDataNeed {
  masterDates: string[];
  priceRange: { from: string; to: string } | null;
  financial: { symbols: string[]; fromYear: number; toYear: number } | null;
  actions: { symbols: string[]; fromYear: number; toYear: number } | null;
  entries: SymbolMasterEntry[];
  marketIndex?: MarketIndexRequirement;
  repairs?: Array<{ kind: "FINANCIAL" | "CORPORATE_ACTION"; symbol: string; year: number }>;
}

/** 수집 실패와 전략 오류를 구분해 필요한 범위만 준비한 뒤 다시 검증한다. */
export class TradingDataRequired extends Error {
  constructor(message: string, readonly need: TradingDataNeed) { super(message); }
}
