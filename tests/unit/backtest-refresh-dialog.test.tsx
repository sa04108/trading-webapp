import { afterEach, describe, expect, it, vi } from "vitest";
import { pendingRequest } from "../../src/web/features/backtests/backtest-refresh-dialog.js";

describe("refresh request identity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the original action and reuses its request ID after an uncertain response", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const action = { kind: "PERIOD_VALIDATION" as const, config: { mode: "HOLDOUT" as const, splitDate: "2023-01-01" } };
    const first = pendingRequest("source", action, "reason");
    action.config.splitDate = "2024-01-01";
    const retry = pendingRequest("source", { kind: "PERIOD_VALIDATION", config: { mode: "HOLDOUT", splitDate: "2023-01-01" } }, "reason");
    const different = pendingRequest("source", action, "reason");
    expect(first.action).toEqual({ kind: "PERIOD_VALIDATION", config: { mode: "HOLDOUT", splitDate: "2023-01-01" } });
    expect(retry.requestId).toBe(first.requestId);
    expect(different.requestId).not.toBe(first.requestId);
  });
  it("keeps the request ID when session storage is blocked", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const action = { kind: "CLONE" as const };
    const first = pendingRequest("storage-blocked", action, "reason");
    expect(pendingRequest("storage-blocked", action, "reason").requestId).toBe(first.requestId);
  });
});
