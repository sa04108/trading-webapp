import { describe, expect, it, vi } from "vitest";
import { TradingDataPreparation } from "../../src/server/modules/trading/application/trading-data-preparation.js";
import type { TradingDataNeed } from "../../src/server/modules/trading/application/trading-data.js";
import type { FactSyncReport } from "../../src/runtime/modules/facts/application/fact-sync-port.js";

const need: TradingDataNeed = { masterDates: ["2026-11-12"], priceRange: { from: "2026-11-11", to: "2026-11-12" }, financial: { symbols: ["005930", "000660"], fromYear: 2023, toYear: 2026 }, actions: { symbols: ["005930", "000660"], fromYear: 2025, toYear: 2027 }, entries: [{ standardCode: "KR7005930003", shortCode: "005930", name: "삼성전자", market: "KOSPI", sharesOutstanding: "1", instrumentType: "COMMON_STOCK", listedDate: "2000-01-01" }] };
const emptyNeed: TradingDataNeed = { masterDates: [], priceRange: null, financial: null, actions: null, entries: [] };
function fixture() {
  const report: FactSyncReport = { savedFacts: 0, gapCount: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null };
  const deps = {
    master: { ingestDate: vi.fn(async (_date: string) => undefined), ensureTradingDay: vi.fn(async () => undefined), ensureSelectionMetrics: vi.fn(async () => undefined) },
    symbols: { getRegisteredIdentity: vi.fn(() => null), getRegisteredIdentityByStandardCode: vi.fn(() => null), addSymbol: vi.fn() },
    facts: { planFinancialSync: vi.fn(), planCorporateActionSync: vi.fn(), sync: vi.fn(async (): Promise<FactSyncReport> => report), syncCorporateActions: vi.fn(async (): Promise<FactSyncReport> => report) },
    usage: { recordCall: vi.fn(), callsUsed: () => 0, maxCallsUsed: () => 0, quotaExceeded: () => false, reportQuotaExceeded: vi.fn() },
  };
  const preparer = new TradingDataPreparation(deps as unknown as ConstructorParameters<typeof TradingDataPreparation>[0]);
  return { deps, preparer, progress: vi.fn(), shouldStop: vi.fn(() => false) };
}
describe("고정 전략 데이터 준비", () => {
  it("동결 전략·기존 보유 종목의 전체 범위를 증분 준비한다", async () => {
    const f = fixture();
    await f.preparer.prepare(need, f.progress, f.shouldStop);
    expect(f.deps.master.ingestDate.mock.calls.map(c => c[0])).toEqual(["2026-11-11", "2026-11-12"]);
    expect(f.deps.facts.sync).toHaveBeenCalledExactlyOnceWith({ ...need.financial, consolidated: true, mode: "INCREMENTAL" }, expect.any(Object));
    expect(f.deps.facts.syncCorporateActions).toHaveBeenCalledExactlyOnceWith({ ...need.actions, consolidated: true, mode: "INCREMENTAL" }, expect.any(Object));
  });
  it("중복 복구를 접고 지정된 종목과 연도만 강제 재처리한다", async () => {
    const f = fixture();
    await f.preparer.prepare({ ...emptyNeed, repairs: [
      { kind: "CORPORATE_ACTION", symbol: "005930", year: 2024 },
      { kind: "CORPORATE_ACTION", symbol: "005930", year: 2024 },
      { kind: "FINANCIAL", symbol: "000660", year: 2022 },
    ] }, f.progress, f.shouldStop);
    expect(f.deps.facts.syncCorporateActions).toHaveBeenCalledExactlyOnceWith({ symbols: ["005930"], fromYear: 2024, toYear: 2024, consolidated: true, mode: "FULL" }, expect.any(Object));
    expect(f.deps.facts.sync).toHaveBeenCalledExactlyOnceWith({ symbols: ["000660"], fromYear: 2022, toYear: 2022, consolidated: true, mode: "FULL" }, expect.any(Object));
  });
  it("정보성 결손은 실패로 취급하지 않는다", async () => {
    const f = fixture();
    f.deps.facts.syncCorporateActions.mockResolvedValueOnce({ savedFacts: 0, gapCount: 1, gaps: [{ symbol: "005930", periodKey: "2024", reason: "미사용 계정", severity: "INFORMATIONAL" }], stoppedAtSymbol: null, stopReason: null, failureMessage: null });
    await expect(f.preparer.prepare({ ...emptyNeed, repairs: [{ kind: "CORPORATE_ACTION", symbol: "005930", year: 2024 }] }, f.progress, f.shouldStop)).resolves.toBeUndefined();
    f.deps.facts.syncCorporateActions.mockResolvedValueOnce({ savedFacts: 0, gapCount: 1, gaps: [{ symbol: "005930", periodKey: "2024", reason: "직전 발행주식수 없음", severity: "BLOCKING", kind: "MISSING" }], stoppedAtSymbol: null, stopReason: null, failureMessage: null });
    await expect(f.preparer.prepare({ ...emptyNeed, repairs: [{ kind: "CORPORATE_ACTION", symbol: "005930", year: 2024 }] }, f.progress, f.shouldStop)).resolves.toContain("005930 2024: 직전 발행주식수 없음");
  });
  it("형식 오류 결손의 종목, 기간과 원인을 전달한다", async () => {
    const f = fixture();
    f.deps.facts.syncCorporateActions.mockResolvedValue({ savedFacts: 0, gapCount: 1, gaps: [{ symbol: "005930", periodKey: "2024-Q1", reason: "잘못된 비율", severity: "BLOCKING", kind: "INVALID" }], stoppedAtSymbol: null, stopReason: null, failureMessage: null });
    await expect(f.preparer.prepare({ ...emptyNeed, actions: need.actions }, f.progress, f.shouldStop)).resolves.toContain("005930 2024-Q1: 잘못된 비율");
    await expect(f.preparer.prepare({ ...emptyNeed, repairs: [{ kind: "CORPORATE_ACTION", symbol: "005930", year: 2024 }] }, f.progress, f.shouldStop)).rejects.toThrow("005930 2024-Q1: 잘못된 비율");
  });
  it("수집 실패와 취소를 호출자에게 전달한다", async () => {
    const f = fixture();
    f.deps.master.ingestDate.mockRejectedValueOnce(new Error("KRX_EMPTY_PENDING"));
    await expect(f.preparer.prepare(need, f.progress, f.shouldStop)).rejects.toThrow("KRX_EMPTY_PENDING");
    expect(f.deps.facts.sync).not.toHaveBeenCalled();
    f.shouldStop.mockReturnValue(true);
    await expect(f.preparer.prepare(need, f.progress, f.shouldStop)).rejects.toThrow("중단");
    expect(f.deps.master.ingestDate).toHaveBeenCalledTimes(1);
  });
  it("수집 중 취소되면 다음 DART 요청 전에 중단한다", async () => {
    const f = fixture();
    await f.preparer.prepare({ ...emptyNeed, actions: { symbols: ["005930"], fromYear: 2024, toYear: 2024 } }, f.progress, f.shouldStop);
    const hooks = (f.deps.facts.syncCorporateActions.mock.calls as unknown as Array<[unknown, { beforeDartRequest(): string }]>)[0]![1];
    f.shouldStop.mockReturnValue(true);
    expect(() => hooks.beforeDartRequest()).toThrow("중단");
  });
});
