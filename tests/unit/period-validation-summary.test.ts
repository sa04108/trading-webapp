import { describe, expect, it } from "vitest";
import { summarizeValidationOos } from "../../src/web/features/backtests/period-validation-summary.js";
import type { ValidationTrialDto } from "../../src/shared/schemas/period-validation.js";

const trial = (role: string, status: string, value: number | null, skipReason: string | null = null): ValidationTrialDto => ({
  role, status, skipReason, metrics: value === null ? null : { totalReturnPct: value },
}) as ValidationTrialDto;

describe("평가된 선택 전략 OOS 요약", () => {
  it("평가가 없으면 평균과 표준편차를 표시하지 않는다", () => {
    expect(summarizeValidationOos([trial("OOS", "NOT_EVALUATED", 0, "NO_ELIGIBLE_CANDIDATE")])).toMatchObject({ evaluated: 0, notEvaluated: 1, mean: null, standardDeviation: null, worst: null });
  });
  it("하나만 평가되면 표준편차는 표시하지 않는다", () => {
    expect(summarizeValidationOos([trial("OOS", "COMPLETED", -4)])).toMatchObject({ evaluated: 1, mean: -4, standardDeviation: null, profitable: 0, worst: -4 });
  });
  it("큰 유한 수익률도 오버플로 없이 계산한다", () => {
    const result = summarizeValidationOos([trial("OOS", "COMPLETED", 1e308), trial("OOS", "COMPLETED", -1e308)]);
    expect(result.mean).toBe(0);
    expect(result.standardDeviation).toBe(1e308);
  });
  it("완료된 유한 수익률만 평균과 모집단 표준편차에 넣는다", () => {
    const result = summarizeValidationOos([
      trial("OOS", "COMPLETED", 10), trial("OOS", "COMPLETED", -2),
      trial("OOS", "NOT_EVALUATED", 0, "NO_ELIGIBLE_CANDIDATE"),
      trial("OOS", "RUNNING", 100), trial("OOS", "COMPLETED", Infinity),
      trial("BASELINE", "COMPLETED", 500),
      { ...trial("OOS", "COMPLETED", 100), metrics: { totalReturnPct: 100, intradayDaily: { isComplete: false } } } as ValidationTrialDto,
    ]);
    expect(result).toMatchObject({ evaluated: 2, notEvaluated: 1, mean: 4, profitable: 1, worst: -2 });
    expect(result.standardDeviation).toBeCloseTo(6);
  });
});
