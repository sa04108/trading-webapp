import { describe, expect, it, vi } from "vitest";
import type { Fact, FundamentalField, FundamentalSnapshot } from "../../src/runtime/modules/facts/domain/fact.js";
import { CORPORATE_ACTION_FIELD } from "../../src/runtime/modules/facts/domain/fact.js";
import type { FactQuery } from "../../src/runtime/modules/facts/application/ports.js";
import { PitFactView } from "../../src/runtime/modules/facts/domain/pit-fact-view.js";
import { BacktestFundamentalView } from "../../src/runtime/modules/backtest/application/backtest-fundamental-view.js";

const FIELDS: readonly FundamentalField[] = [
  "OPERATING_INCOME",
  "NET_INCOME",
  "TOTAL_EQUITY",
  "CURRENT_ASSETS",
];

function fact(
  key: string,
  field: string,
  periodKey: string,
  asOfTsMs: number,
  value: number,
  scope: Fact["scope"] = "SYMBOL",
): Fact {
  return { scope, key, field, periodKey, asOfTsMs, value, unit: "KRW" };
}

function summarize(snapshot: FundamentalSnapshot | null) {
  if (snapshot === null) return null;
  return {
    latestPeriodKey: snapshot.latestPeriodKey,
    latestAsOfTsMs: snapshot.latestAsOfTsMs,
    fields: FIELDS.map((field) => ({
      field,
      value: snapshot.get(field),
      periodKey: snapshot.periodKeyOf(field),
      quarters: [0, 1, 2, 3, 4, 5, 6, 7].map((offset) =>
        snapshot.quarter(field, offset),
      ),
      ttm: snapshot.ttm(field),
    })),
  };
}

function eagerSnapshot(facts: readonly Fact[], symbol: string, tsMs: number) {
  const view = new PitFactView(facts);
  view.advanceTo(tsMs);
  return summarize(view.fundamentals(symbol));
}

describe("BacktestFundamentalView", () => {
  const facts = [
    fact("A", "OPERATING_INCOME", "2024Q1", 10, 11),
    fact("A", "OPERATING_INCOME", "2024Q1", 10, 10), // 동시각 충돌은 값 순서로 결정
    fact("A", "OPERATING_INCOME", "2024Q2", 10, 12),
    fact("A", "OPERATING_INCOME", "2024Q3", 10, 13),
    fact("A", "OPERATING_INCOME", "2024Q4", 10, 14),
    fact("A", "OPERATING_INCOME", "2025Q1", 20, 15),
    fact("A", "OPERATING_INCOME", "2025Q1", 40, 99), // 늦은 정정
    fact("A", "OPERATING_INCOME", "2025Q2", 30, 16),
    fact("A", "NET_INCOME", "2024Q1", 10, 1),
    fact("A", "NET_INCOME", "2024Q2", 10, 2),
    fact("A", "NET_INCOME", "2024Q4", 10, 4), // 2024Q3 구멍
    fact("A", "TOTAL_EQUITY", "2023Q4", 5, 500), // 다른 계정보다 낡은 최신 분기
    fact("A", "CURRENT_ASSETS", "2025FY", 10, 800), // 연간 팩트는 제외
    fact("A", CORPORATE_ACTION_FIELD, "2025-03-14", 1, 2),
    fact("B", "OPERATING_INCOME", "2025Q1", 10, 200),
    fact("B", "TOTAL_EQUITY", "2025Q1", 10, 900),
    fact("MACRO", "OPERATING_INCOME", "2025Q1", 10, 300, "MACRO"),
  ];

  it("종목 단위 cutoff에서 eager PIT 뷰의 결과를 보존한다", () => {
    const readFacts = vi.fn((query: FactQuery) =>
      facts.filter(
        (row) =>
          row.scope === query.scope &&
          query.keys?.includes(row.key) === true &&
          row.asOfTsMs <= query.asOfMaxTsMs!,
      ),
    );
    const view = new BacktestFundamentalView(
      readFacts,
      new Map([
        ["A", 45], // 실행 마지막 시각이 현재 요청보다 앞선 종목
        ["B", 100],
      ]),
    );

    for (const [symbol, tsMs] of [
      ["A", 9], // 공시 전
      ["A", 10], // disclosure boundary 및 동일 시각 tie
      ["B", 10], // 심볼 교차 시 이전 캐시 제거
      ["A", 25], // 심볼 재방문 및 종목 cutoff 적용
      ["A", 35], // 정정 전, 정확한 cutoff에서 재집계 미노출
      ["A", 40], // 정정 후
      ["A", 50], // 종목별 실행 cutoff 적용
    ] as const) {
      const cutoff = Math.min(tsMs, symbol === "A" ? 45 : 100);
      expect(summarize(view.fundamentals(symbol, tsMs))).toEqual(
        eagerSnapshot(facts.filter((row) => row.key === symbol), symbol, cutoff),
      );
    }

    expect(readFacts.mock.calls.map(([query]) => query)).toEqual([
      { scope: "SYMBOL", keys: ["A"], asOfMaxTsMs: 9 },
      { scope: "SYMBOL", keys: ["A"], asOfMaxTsMs: 10 },
      { scope: "SYMBOL", keys: ["B"], asOfMaxTsMs: 10 },
      { scope: "SYMBOL", keys: ["A"], asOfMaxTsMs: 25 },
      { scope: "SYMBOL", keys: ["A"], asOfMaxTsMs: 35 },
      { scope: "SYMBOL", keys: ["A"], asOfMaxTsMs: 40 },
      { scope: "SYMBOL", keys: ["A"], asOfMaxTsMs: 45 },
    ]);
  });

  it("미등록 종목은 읽지 않고 null 결과도 한 항목만 캐시한다", () => {
    const readFacts = vi.fn((): readonly Fact[] => []);
    const view = new BacktestFundamentalView(readFacts, new Map([["A", 100]]));

    expect(view.fundamentals("UNKNOWN", 50)).toBeNull();
    expect(readFacts).not.toHaveBeenCalled();
    expect(view.fundamentals("A", 50)).toBeNull();
    expect(view.fundamentals("A", 50)).toBeNull();
    expect(readFacts).toHaveBeenCalledTimes(1);
    expect(view.fundamentals("A", 51)).toBeNull();
    expect(readFacts).toHaveBeenCalledTimes(2);
  });

  it("이전 시각과 미래 시각을 번갈아 요청해도 해당 시점 PIT를 재구성한다", () => {
    const readFacts = vi.fn((query: FactQuery) =>
      facts.filter(
        (row) =>
          row.scope === query.scope &&
          query.keys?.includes(row.key) === true &&
          row.asOfTsMs <= query.asOfMaxTsMs!,
      ),
    );
    const view = new BacktestFundamentalView(readFacts, new Map([["A", 100]]));

    const beforeRestatement = summarize(view.fundamentals("A", 35));
    expect(summarize(view.fundamentals("A", 40))).not.toEqual(beforeRestatement);
    expect(summarize(view.fundamentals("A", 35))).toEqual(beforeRestatement);
  });
});
