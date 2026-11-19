import type { MarketIndexRequirement } from "../../../../runtime/modules/market-data/domain/market-index.js";
import type { SymbolMasterService } from "../../../../runtime/modules/market-data/application/symbol-master-service.js";
import type { SymbolService } from "../../../../runtime/modules/market-data/application/symbol-service.js";
import type { FactSyncHooks, FactSyncPort, FactSyncRequest } from "../../../../runtime/modules/facts/application/fact-sync-port.js";
import type { ExternalApiUsage } from "../../../../runtime/shared/external-api-usage.js";
import { DART_DAILY_CALL_LIMIT } from "../../../../runtime/modules/facts/domain/sync-plan.js";
import { addCalendarDays } from "../../../../runtime/modules/market-data/domain/kst-date.js";
import type { TradingDataNeed } from "./trading-data.js";

/** 동결된 전략 자식이 요구한 범위만 준비한다. 최신 전략 레지스트리는 참조하지 않는다. */
export class TradingDataPreparation {
  constructor(private readonly deps: {
    ensureMarketIndex?: (requirement: MarketIndexRequirement, shouldStop: () => boolean, onProgress: (completed: number, total: number, date: string) => void) => Promise<void>;
    master: Pick<SymbolMasterService, "ingestDate" | "ensureTradingDay" | "ensureSelectionMetrics">;
    symbols: Pick<SymbolService, "getRegisteredIdentity" | "getRegisteredIdentityByStandardCode" | "addSymbol">;
    facts: FactSyncPort;
    usage: ExternalApiUsage;
  }) {}

  async prepare(need: TradingDataNeed, onProgress: (message: string) => void, shouldStop: () => boolean): Promise<string | void> {
    const diagnostics: string[] = [];
    const checkStop = () => {
      if (shouldStop()) throw new Error("매매 데이터 준비가 중단되었습니다.");
    };
    checkStop();
    if (need.marketIndex) {
      if (!this.deps.ensureMarketIndex) throw new Error("KOSPI 지수 준비기가 없습니다");
      await this.deps.ensureMarketIndex(need.marketIndex, shouldStop, (completed, total, date) => {
        onProgress(`매매 데이터 준비 중 · KOSPI ${completed}/${total} (${date})`);
      });
      checkStop();
    }
    const dates = new Set(need.masterDates);
    if (need.priceRange) {
      let count = 0;
      for (let date = need.priceRange.from; date <= need.priceRange.to; date = addCalendarDays(date, 1)) {
        if (++count > 10_000) throw new Error("요청한 가격 이력 범위가 너무 큽니다.");
        dates.add(date);
      }
    }
    let done = 0;
    for (const date of [...dates].sort()) {
      checkStop();
      onProgress(`매매 데이터 준비 중 · KRX ${++done}/${dates.size} (${date})`);
      await this.deps.master.ingestDate(date);
    }
    // 리밸런스 기준일이 휴장일이면 직전 개장일도 확보한다.
    for (const date of need.masterDates) {
      checkStop();
      await this.deps.master.ensureTradingDay(date);
    }
    checkStop();
    await this.deps.master.ensureSelectionMetrics(need.masterDates);
    for (const entry of need.entries) {
      checkStop();
      const registered = this.deps.symbols.getRegisteredIdentity(entry.shortCode);
      const owner = this.deps.symbols.getRegisteredIdentityByStandardCode(entry.standardCode);
      if ((registered && registered.standardCode !== entry.standardCode) || (owner && owner.code !== entry.shortCode)) throw new Error(`종목 정체성을 확인할 수 없습니다: ${entry.shortCode}`);
      if (!registered) this.deps.symbols.addSymbol(entry.shortCode, "KR", entry.name, entry.standardCode);
    }

    const sync = async (kind: "FINANCIAL" | "CORPORATE_ACTION", request: FactSyncRequest) => {
      checkStop();
      const label = kind === "FINANCIAL" ? "재무" : "자본변동";
      onProgress(`매매 데이터 준비 중 · ${label} ${request.symbols.length === 1 ? `${request.symbols[0]} · ` : ""}${request.fromYear}–${request.toYear}년`);
      const hooks: FactSyncHooks = {
        shouldStop,
        beforeDartRequest: () => {
          checkStop();
          return this.deps.usage.quotaExceeded("DART", "daily") || this.deps.usage.callsUsed("DART", "daily") >= DART_DAILY_CALL_LIMIT ? "PAUSE_DAILY_QUOTA" : "CONTINUE";
        },
        onSymbolDone: (progress) => onProgress(`매매 데이터 준비 중 · ${label} ${progress.symbol} · ${request.fromYear}–${request.toYear}년 (${progress.index}/${progress.total})`),
      };
      const report = kind === "FINANCIAL" ? await this.deps.facts.sync(request, hooks) : await this.deps.facts.syncCorporateActions(request, hooks);
      if (report.stopReason) throw new Error(report.failureMessage ?? `${label} 데이터 수집이 중단되었습니다: ${report.stopReason}`);
      checkStop();
      const blocking = report.gaps.filter((gap) => gap.severity === "BLOCKING");
      const invalid = blocking.filter((gap) => gap.kind === "INVALID" || gap.kind === "CONFLICT");
      const details = (invalid.length ? invalid : blocking).slice(0, 5).map((gap) => `${gap.symbol} ${gap.periodKey}: ${gap.reason}`).join("; ");
      if (invalid.length && (kind === "FINANCIAL" || request.mode === "FULL")) throw new Error(`${label} 원문 재검증 후에도 결손이 남았습니다: ${details}`);
      if (blocking.length) {
        const message = `${label} 데이터 결손 확인: ${details}`;
        if (diagnostics.length < 5) diagnostics.push(message);
        onProgress(message);
      }
    };

    for (const [kind, range] of [["FINANCIAL", need.financial], ["CORPORATE_ACTION", need.actions]] as const) {
      if (range?.symbols.length) await sync(kind, { ...range, consolidated: true, mode: "INCREMENTAL" });
    }
    const seen = new Set<string>();
    for (const repair of need.repairs ?? []) {
      checkStop();
      const key = JSON.stringify([repair.kind, repair.symbol, repair.year]);
      if (seen.has(key)) continue;
      seen.add(key);
      await sync(repair.kind, { symbols: [repair.symbol], fromYear: repair.year, toYear: repair.year, consolidated: true, mode: "FULL" });
    }
    checkStop();
    if (diagnostics.length) return diagnostics.join("; ");
  }
}
