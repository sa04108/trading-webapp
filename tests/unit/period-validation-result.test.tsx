import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ValidationResult } from "@/features/backtests/period-validation-section";
import type { PeriodValidationDto, ValidationTrialDto } from "../../src/shared/schemas/period-validation.js";

const period = { from: "2020-01-01", to: "2020-06-30" };
const base = { fold: 0, candidate: 0, period, parameters: { x: 10 }, jobId: null, progress: null, error: null, skipReason: null, selection: null };
const config: PeriodValidationDto["config"] = { mode: "HOLDOUT", splitDate: "2020-07-01", optimization: { axes: [{ key: "x", values: [10, 20] }], objective: "sharpe", minTrades: 5, maxDrawdownPct: 30 } };
const experiment = (trials: ValidationTrialDto[]): PeriodValidationDto => ({
  id: "v", sourceJobId: "source", status: "COMPLETED", config,
  plan: { folds: [{ ordinal: 0, train: period, test: period }], candidates: [{ x: 10 }, { x: 20 }], totalRuns: 4, unusedPeriod: null },
  initialCash: 1000, createdAtMs: 1, error: null, trials,
});
const render = (trials: ValidationTrialDto[], validation = experiment(trials)) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter><TooltipProvider><ValidationResult experiment={validation} specs={[]} refresh={async () => {}} /></TooltipProvider></MemoryRouter></QueryClientProvider>,
);

describe("기간 검증 결과 표시", () => {
  it("후보 없는 회차를 0 수익률이 아닌 미평가로 나타낸다", () => {
    const html = render([{ ...base, id: "oos", role: "OOS", status: "NOT_EVALUATED", candidate: null, parameters: null, metrics: null, skipReason: "NO_ELIGIBLE_CANDIDATE" }]);
    expect(html).toContain("홀드아웃 · 최적화 켜짐");
    expect(html).toContain("미평가 (선택 후보 없음)");
    expect(html).toContain("평균 수익률 —");
    expect(html).toContain("표준편차 —");
    expect(html).not.toContain("0.00%");
  });
  it("후보별 실제 수치와 경계 기준, 탈락 사유를 보여준다", () => {
    const metrics = { totalReturnPct: 1, cagrPct: 1, sharpe: 1, tradeCount: 4, maxDrawdownPct: -31 };
    const html = render([{ ...base, id: "train", role: "TRAIN", status: "COMPLETED", metrics, selection: { eligible: false, reasons: ["INSUFFICIENT_TRADES", "DRAWDOWN_LIMIT_EXCEEDED"] } }]);
    expect(html).toContain("조건 탈락");
    expect(html).toContain("매도 체결 수 미달");
    expect(html).toContain("MDD 한도 초과");
    expect(html).toMatch(/4건.*5건 이상/);
    expect(html).toMatch(/31\.00%.*30% 이하/);
  });
  it("최적화 없는 워크포워드는 원본 설정 OOS를 표시하고 선택 조건을 숨긴다", () => {
    const validation: PeriodValidationDto = { ...experiment([{ ...base, id: "train", role: "TRAIN", status: "COMPLETED", metrics: null }]), config: { mode: "WALK_FORWARD", trainMonths: 3, testMonths: 1 } };
    const html = render([{ ...base, id: "train", role: "TRAIN", status: "COMPLETED", metrics: null }], validation);
    expect(html).toContain("워크포워드 · 최적화 꺼짐");
    expect(html).toContain("원본 설정 OOS 평가");
    expect(html).toContain("원본 설정 IS");
    expect(html).not.toContain("후보 선택 조건");
    expect(html).not.toContain("고정 전략 OOS");
    expect(html).not.toContain("후보가 없어 미평가");
  });
  it("MDD가 한도를 근소하게 넘으면 반올림으로 차이를 숨기지 않는다", () => {
    const metrics = { totalReturnPct: 1, cagrPct: 1, sharpe: 1, tradeCount: 5, maxDrawdownPct: -30.00001 };
    const html = render([{ ...base, id: "train", role: "TRAIN", status: "COMPLETED", metrics, selection: { eligible: false, reasons: ["DRAWDOWN_LIMIT_EXCEEDED"] } }]);
    expect(html).toContain("30.00001%");
    expect(html).toContain("MDD 한도 초과");
  });

});
