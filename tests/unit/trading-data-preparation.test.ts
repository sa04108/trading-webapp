import { describe, expect, it, vi } from "vitest";
import { TradingDataPreparation } from "../../src/server/modules/trading/application/trading-data-preparation.js";
import type { TradingDataNeed } from "../../src/server/modules/trading/application/trading-data.js";

const need: TradingDataNeed = { masterDates: ["2026-11-12"], priceRange: { from: "2026-11-11", to: "2026-11-12" }, financial: { symbols: ["005930", "000660"], fromYear: 2023, toYear: 2026 }, actions: { symbols: ["005930", "000660"], fromYear: 2025, toYear: 2027 }, entries: [{ standardCode: "KR7005930003", shortCode: "005930", name: "삼성전자", market: "KOSPI", sharesOutstanding: "1", instrumentType: "COMMON_STOCK", listedDate: "2000-01-01" }] };
function fixture() {
  const report = { savedFacts: 0, gapCount: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null };
  const deps = {
    master: { ingestDate: vi.fn(async (_date: string) => undefined), ensureTradingDay: vi.fn(async () => undefined), ensureSelectionMetrics: vi.fn(async () => undefined) },
    symbols: { getRegisteredIdentity: vi.fn(() => null), getRegisteredIdentityByStandardCode: vi.fn(() => null), addSymbol: vi.fn() },
    facts: { planFinancialSync: vi.fn(), planCorporateActionSync: vi.fn(), sync: vi.fn(async () => report), syncCorporateActions: vi.fn(async () => report) },
    usage: { recordCall: vi.fn(), callsUsed: () => 0, maxCallsUsed: () => 0, quotaExceeded: () => false, reportQuotaExceeded: vi.fn() },
    progress: vi.fn(),
  };
  // 외부 수집의 반환 본문은 준비기에서 읽지 않으므로 테스트 포트는 호출 경계만 대체한다.
  const preparer = new TradingDataPreparation(deps as unknown as ConstructorParameters<typeof TradingDataPreparation>[0]);
  return { deps, preparer };
}
describe("고정 전략 데이터 준비", () => {
  it("최신 레지스트리 없이 동결 전략·기존 보유 종목의 전체 범위를 한 번 준비한다", async () => {
    const f = fixture();
    try {
      f.preparer.request("deployment", "old-hash", need);
      f.preparer.request("deployment", "old-hash", need);
      await vi.waitFor(() => expect(f.deps.progress).toHaveBeenCalledWith("deployment", expect.stringContaining("수집 완료")));
      expect(f.deps.master.ingestDate.mock.calls.map(c => c[0])).toEqual(["2026-11-11", "2026-11-12"]);
      expect(f.deps.facts.sync).toHaveBeenCalledExactlyOnceWith({ ...need.financial, consolidated: true, mode: "INCREMENTAL" }, expect.any(Object));
      expect(f.deps.facts.syncCorporateActions).toHaveBeenCalledExactlyOnceWith({ ...need.actions, consolidated: true, mode: "INCREMENTAL" }, expect.any(Object));
      expect(() => f.preparer.request("deployment", "old-hash", need)).toThrow(/수집 후에도/);
    } finally { await f.preparer.close(); }
  });
  it("공급자 실패를 준비 중으로 숨기지 않고 실패 원인을 보고한다", async () => {
    const f = fixture(); f.deps.master.ingestDate.mockRejectedValueOnce(new Error("KRX_EMPTY_PENDING"));
    try {
      f.preparer.request("deployment", "old-hash", need);
      await vi.waitFor(() => expect(f.deps.progress).toHaveBeenCalledWith("deployment", "매매 데이터 준비 실패: KRX_EMPTY_PENDING", true));
      expect(f.deps.facts.sync).not.toHaveBeenCalled();
    } finally { await f.preparer.close(); }
  });
});
