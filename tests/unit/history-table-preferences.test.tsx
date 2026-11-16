import { describe, expect, it } from "vitest";
import { DEFAULT_HISTORY_TABLE_PREFERENCES, normalizeHistoryTablePreferences } from "../../src/web/features/backtests/history-table-preferences.js";

describe("백테스트 표 설정 복구", () => {
  it("손상되거나 지원하지 않는 설정은 기본값으로 복구한다", () => {
    for (const value of [null, [], "invalid", { version: 2 }]) {
      expect(normalizeHistoryTablePreferences(value)).toEqual(DEFAULT_HISTORY_TABLE_PREFERENCES);
    }
    expect(normalizeHistoryTablePreferences({ version: 1, order: null, visible: null }))
      .toEqual(DEFAULT_HISTORY_TABLE_PREFERENCES);
  });

  it("오래된 설정의 유효한 순서와 빈 표시 목록을 유지하며 누락된 항목을 추가한다", () => {
    expect(normalizeHistoryTablePreferences({
      version: 1,
      order: ["seed", "unknown", "return", "seed"],
      visible: [],
    })).toEqual({
      version: 1,
      order: ["seed", "return", "cagr", "mdd", "date", "sharpe", "validation"],
      visible: [],
    });
    expect(normalizeHistoryTablePreferences({ version: 1, order: [], visible: ["validation", "unknown", "validation"] }).visible)
      .toEqual(["validation"]);
  });
});
