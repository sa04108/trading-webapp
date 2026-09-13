import { FactSyncService } from '../../src/server/modules/facts/application/fact-sync-service.js';
import type { FactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import type { CorporateActionCoverageStore } from '../../src/server/modules/facts/application/corporate-action-coverage.js';
import type { FactIngestionGap, FactRepository, FactSource, FetchFinancialsRequest } from '../../src/server/modules/facts/application/ports.js';

const financial = process.argv[2] === 'financial';
let persistedGaps = 0;
let persistedBlockingGaps = 0;
let maxRssMiB = 0;
let maxHeapMiB = 0;
const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const coverage: FactCoverageStore = {
  getCoveredYears: () => new Map(), getUpdatedAtMs: () => new Map(),
  getCoverageState: () => new Map(), getProcessedFilingReceiptNos: () => new Set(),
  addCoveredYears() {}, addProcessedFilings() {},
  addCoverageResult(_symbol, _years, gaps) {
    persistedGaps += gaps.length;
    persistedBlockingGaps += gaps.filter((gap) => gap.severity === 'BLOCKING').length;
  },
};
const actionCoverage: CorporateActionCoverageStore = {
  getGapYears: () => new Map(),
  getCoveredYears: () => new Map(), getUpdatedAtMs: () => new Map(),
  addCoveredYears() {}, addGapYears() {},
  addCoverageResult(_symbol, _years, _gapYears, _now, details) {
    persistedGaps += details?.length ?? 0;
    persistedBlockingGaps += details?.filter((gap) => gap.severity === 'BLOCKING').length ?? 0;
  },
};
const repository: FactRepository = {
  getFacts: async () => [], saveFacts: async () => {},
  replaceSymbolFinancialFactsForYear: async () => {},
  replaceSymbolCorporateActionFactsForYear: async () => {},
};
/** 운영 관측치인 종목당 약 3,190건을 재현하며 저장 대역은 원문을 보관하지 않는다. */
function gaps(request: FetchFinancialsRequest): FactIngestionGap[] {
  return Array.from({ length: 290 }, (_, index) => ({
    symbol: request.symbols[0]!, periodKey: `${request.years[0]}Q${index % 4 + 1}`,
    severity: index === 289 ? 'BLOCKING' : 'INFORMATIONAL',
    reason: `매핑되지 않은 계정: 기타금융자산${index} (entity_${request.symbols[0]}_${request.years[0]}_OtherFinancialAssets${index})`,
  }));
}
const source: FactSource = {
  fetchFinancials: async (request) => ({ facts: [], gaps: financial ? gaps(request) : [] }),
  fetchCorporateActions: async (request) => ({ facts: [], gaps: financial ? [] : gaps(request) }),
  listRecentPeriodicFilings: async () => [],
};
const service = new FactSyncService(source, repository, logger, { bumpVersion() {} },
  { now: () => Date.UTC(2026, 8, 13) }, coverage, actionCoverage);
const request = {
  symbols: Array.from({ length: 212 }, (_, index) => String(index).padStart(6, '0')),
  fromYear: 2016, toYear: 2026, consolidated: true, mode: 'INCREMENTAL' as const,
};
const hooks = { onSymbolDone() {
  const usage = process.memoryUsage();
  maxRssMiB = Math.max(maxRssMiB, usage.rss / 1024 / 1024);
  maxHeapMiB = Math.max(maxHeapMiB, usage.heapUsed / 1024 / 1024);
} };
const report = financial ? await service.sync(request, hooks) : await service.syncCorporateActions(request, hooks);
process.send?.({
  stopReason: report.stopReason, gapCount: report.gapCount, examples: report.gaps.length,
  persistedGaps, persistedBlockingGaps, maxHeapMiB, maxRssMiB,
});
process.disconnect?.();
