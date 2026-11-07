import { FIXTURE_COLLECTION_VERSION } from './universe-preparation-memory-seed.js';
import { createHash } from 'node:crypto';
import { UniverseExecutor } from '../../src/runtime/workers/universe-executor.js';
import { UniverseRuleResolver } from '../../src/runtime/modules/backtest/application/universe-rule-resolver.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/runtime/shared/db/schema.js';
import { KrxDailyCandleRepository } from '../../src/runtime/modules/market-data/infrastructure/krx-daily-candle-repository.js';
import { SelectionMetricRepository } from '../../src/runtime/modules/market-data/application/selection-metric-repository.js';
import { SqliteFactRepository } from '../../src/runtime/modules/facts/infrastructure/sqlite-fact-repository.js';
import { SymbolMasterService } from '../../src/runtime/modules/market-data/application/symbol-master-service.js';
import { SqliteCorporateActionCoverageStore } from '../../src/runtime/modules/facts/application/corporate-action-coverage.js';

const parallel = process.argv[3] === 'parallel';
const excluded = process.argv[4] === 'excluded';
const sqlite = new Database(process.argv[2]!, { readonly: true });
const db = drizzle(sqlite, { schema });
const factRepo = new SqliteFactRepository(db);
const actionCoverage = new SqliteCorporateActionCoverageStore(db, { collectionVersion: FIXTURE_COLLECTION_VERSION });
const getFacts = factRepo.getFacts.bind(factRepo);
factRepo.getFacts = (query) => { maxFactBatch = Math.max(maxFactBatch, query.keys?.length ?? 0); return getFacts(query); };
let maxFactBatch = 0;
const resolver = new UniverseRuleResolver({
  symbolMaster: new SymbolMasterService({ db, source: {} as never, clock: {} as never, logger: {} as never, collectionVersion: FIXTURE_COLLECTION_VERSION }),
  selectionMetrics: new SelectionMetricRepository(db, { collectionVersion: FIXTURE_COLLECTION_VERSION }),
  candles: new KrxDailyCandleRepository(db),
  facts: factRepo,
  factCoverage: {} as never,
  actionCoverage,
  logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
});
const executor = parallel ? new UniverseExecutor(resolver, { dataPath: process.argv[2]!, collectionVersion: FIXTURE_COLLECTION_VERSION, budgetBytes: 1024 ** 3, cpuBudget: 2 }) : null;
const resolve = executor?.resolve ?? resolver.resolveOrDescribeNeeds.bind(resolver);
const result = await resolve({
  markets: ['KOSPI'], rebalanceInterval: { unit: 'MONTH', value: 1 },
  stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 200 }, { criterion: 'DECLINE', direction: 'HIGH', limit: 50, lookbackTradingDays: 20 }],
}, { from: '2016-01-01', to: '2025-12-31' }, { excludedSymbols: excluded ? new Set(['000001', '000002']) : new Set() });
await executor?.close();
const serializable = { ...result, unionEntries: [...result.unionEntries].sort(([a], [b]) => a.localeCompare(b)) };
sqlite.close();
process.send?.({ kind: result.kind, hash: createHash('sha256').update(JSON.stringify(serializable)).digest('hex'),
  dates: result.kind === 'READY' ? result.schedule.length : 0,
  members: result.kind === 'READY' ? result.schedule.reduce((sum, date) => sum + date.members.length, 0) : 0,
  actionSymbols: result.kind === 'NEEDS_DATA' ? result.needs.actionSymbols : [],
  maxFactBatch, maxRssMiB: process.resourceUsage().maxRSS / 1024,
}, () => process.disconnect());
