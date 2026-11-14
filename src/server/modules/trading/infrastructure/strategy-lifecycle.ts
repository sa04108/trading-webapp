/** 전략 자체의 백테스트 동작은 유지하고, 실제 주문 결과가 확정된 경계에서만 호출한다. */
export function reconcileState(id: string, value: unknown, input: { interrupted: boolean; positions: readonly string[]; symbols: readonly string[] }): void {
  if (!value || typeof value !== "object") throw new Error("전략 상태가 올바르지 않습니다");
  const state = value as Record<string, unknown>;
  const swing = ["range-breakout", "ema-trend-switch", "rsi-reversion"].includes(id);
  const rank = ["cross-sectional-momentum", "earnings-acceleration-rank", "low-per-high-roe-rank", "value-quality-rank"].includes(id);
  if (!swing && !rank) throw new Error("실거래 상태 동기화를 지원하지 않는 전략입니다");
  if (id !== "range-breakout") {
    if (!Array.isArray(state.symbols) || !state.symbols.every((symbol) => typeof symbol === "string")) throw new Error("전략 종목 상태가 올바르지 않습니다");
    state.symbols = [...new Set([...state.symbols, ...input.symbols, ...input.positions])].sort();
  }
  if (rank) {
    if (!("pendingTargets" in state) || !(state.pendingTargets === null || Array.isArray(state.pendingTargets))) throw new Error("전략 리밸런스 상태가 올바르지 않습니다");
    if (input.interrupted) state.pendingTargets = null;
    return;
  }
  if (!(state.bySymbol instanceof Map)) throw new Error("전략 종목 상태가 올바르지 않습니다");
  for (const [symbol, item] of state.bySymbol) {
    if (typeof symbol !== "string" || !item || typeof item !== "object" || !item.holding || typeof item.holding !== "object" || typeof item.holding.exitPending !== "boolean" || typeof item.holding.pendingEntry !== "boolean") throw new Error("전략 보유 상태가 올바르지 않습니다");
    item.holding.exitPending = false;
    item.holding.pendingEntry = false;
  }
  for (const symbol of input.positions) {
    const item = state.bySymbol.get(symbol);
    if (!item || !item.holding || !item.atr) throw new Error(`보유 종목의 전략 준비가 부족합니다: ${symbol}`);
    if (item.holding.entryAtr !== null && (typeof item.holding.entryAtr !== "number" || !Number.isFinite(item.holding.entryAtr) || item.holding.entryAtr <= 0)) throw new Error(`보유 종목의 진입 변동성이 올바르지 않습니다: ${symbol}`);
    if (item.holding.entryAtr === null) {
      if (typeof item.atr.atr !== "number" || !Number.isFinite(item.atr.atr) || item.atr.atr <= 0) throw new Error(`보유 종목의 변동성 준비가 부족합니다: ${symbol}`);
      item.holding.entryAtr = item.atr.atr;
      item.holding.stopLevel = null;
    }
  }
}
