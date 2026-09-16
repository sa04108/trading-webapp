import { describe, expect, it } from "vitest";
import { coverageContainsRange, unionCoverageIntervals } from "../../src/runtime/modules/market-data/domain/coverage-intervals.js";

describe("B: 과거 수집 이력의 비파괴 합집합", () => {
  it("순서·중첩·인접·이전 실행 해시와 무관하게 합치되 실제 하루 결손은 보존한다", () => {
    const rows = [
      { startDate: "2026-01-07", endDate: "2026-01-08", syncedAtMs: 3, collectionVersion: "B" },
      { startDate: "2026-01-01", endDate: "2026-01-03", syncedAtMs: 1, collectionVersion: null },
      { startDate: "2026-01-03", endDate: "2026-01-05", syncedAtMs: 2, collectionVersion: "A" },
      { startDate: "2026-01-02", endDate: "2026-01-02", syncedAtMs: 0, collectionVersion: "B" },
    ];
    const original = structuredClone(rows);
    expect(unionCoverageIntervals(rows)).toEqual([
      { startDate: "2026-01-01", endDate: "2026-01-05", syncedAtMs: 2 },
      { startDate: "2026-01-07", endDate: "2026-01-08", syncedAtMs: 3 },
    ]);
    expect(coverageContainsRange(rows, "2026-01-01", "2026-01-05")).toBe(true);
    expect(coverageContainsRange(rows, "2026-01-01", "2026-01-08")).toBe(false);
    expect(coverageContainsRange(rows, "2026-01-06", "2026-01-06")).toBe(false);
    expect(rows).toEqual(original);
  });

  it("월말·윤년·연말의 실제 인접 날짜만 연결한다", () => {
    for (const [left, right] of [["2024-02-29", "2024-03-01"], ["2025-12-31", "2026-01-01"]]) {
      const rows = [
        { startDate: left!, endDate: left!, syncedAtMs: 1 },
        { startDate: right!, endDate: right!, syncedAtMs: 2 },
      ];
      expect(coverageContainsRange(rows, left!, right!)).toBe(true);
    }
  });

  it("잘못된 범위를 넓은 정상 coverage로 인증하지 않는다", () => {
    expect(() => unionCoverageIntervals([{ startDate: "2026-01-03", endDate: "2026-01-01", syncedAtMs: 1 }])).toThrow();
    expect(coverageContainsRange([], "2026-01-01", "2026-01-02")).toBe(false);
  });
});
