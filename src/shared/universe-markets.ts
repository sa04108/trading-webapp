import type { UniverseRule } from "./schemas/universe-rule.js";

type UniverseMarket = UniverseRule["markets"][number];

export const DEFAULT_UNIVERSE_MARKETS = ["KOSPI", "KOSDAQ"] as const;

export const UNIVERSE_MARKET_OPTIONS = [
  { value: "KOSPI+KOSDAQ", label: "코스피+코스닥", markets: DEFAULT_UNIVERSE_MARKETS },
  { value: "KOSPI", label: "코스피", markets: ["KOSPI"] },
  { value: "KOSDAQ", label: "코스닥", markets: ["KOSDAQ"] },
] as const;

export function getUniverseMarketSelection(markets: readonly UniverseMarket[]) {
  const option = UNIVERSE_MARKET_OPTIONS.find(
    (option) => option.markets.length === markets.length && option.markets.every((market) => markets.includes(market)),
  );
  if (!option) throw new Error("지원하지 않는 유니버스 시장입니다.");
  return option.value;
}

export function getUniverseMarkets(selection: string): UniverseMarket[] {
  const option = UNIVERSE_MARKET_OPTIONS.find((option) => option.value === selection);
  if (!option) throw new Error("지원하지 않는 유니버스 시장입니다.");
  return [...option.markets];
}
