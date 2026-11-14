import { describe, expect, it } from "vitest";
import { reconcileState } from "../../src/server/modules/trading/infrastructure/strategy-lifecycle.js";

describe("live strategy lifecycle", () => {
  it("clears stale entry and exit intents and restores held ATR", () => {
    const holding = { pendingEntry: true, exitPending: true, entryAtr: null, stopLevel: null, highestClose: null, barsHeld: 3 };
    const state = { bySymbol: new Map([["005930", { holding, atr: { atr: 3 } }]]) };
    reconcileState("range-breakout", state, { interrupted: true, positions: ["005930"], symbols: ["005930"] });
    expect(holding).toMatchObject({ pendingEntry: false, exitPending: false, entryAtr: 3, stopLevel: null, barsHeld: 3 });
  });
  it("preserves two-phase targets when settled and clears them after interruption", () => {
    const state = { symbols: ["005930"], pendingTargets: [{ symbol: "005930" }] };
    reconcileState("cross-sectional-momentum", state, { interrupted: false, positions: [], symbols: ["000660"] });
    expect(state.pendingTargets).not.toBeNull();
    expect(state.symbols).toEqual(["000660", "005930"]);
    reconcileState("cross-sectional-momentum", state, { interrupted: true, positions: [], symbols: [] });
    expect(state.pendingTargets).toBeNull();
  });
});
