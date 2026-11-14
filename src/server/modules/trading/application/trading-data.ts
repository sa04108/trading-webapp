import type { SymbolMasterEntry } from "../../../../runtime/modules/market-data/domain/symbol-master.js";

export interface TradingDataNeed {
  masterDates: string[];
  priceRange: { from: string; to: string } | null;
  financial: { symbols: string[]; fromYear: number; toYear: number } | null;
  actions: { symbols: string[]; fromYear: number; toYear: number } | null;
  entries: SymbolMasterEntry[];
}
