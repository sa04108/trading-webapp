import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/server/shared/db/schema.js';
import { CandleCoverageService } from '../../src/server/modules/market-data/application/candle-coverage-service.js';
import { SqliteFactRepository } from '../../src/server/modules/facts/infrastructure/sqlite-fact-repository.js';
import {
  findIncompleteFundamentalCheckpoints,
  findIncompleteFundamentalCheckpointsFromCoverage,
  findIncompleteFundamentalCheckpointsFromCoverageSync,
} from '../../src/server/modules/backtest/application/backtest-financial-data-readiness.js';
import { lowPerHighRoeRankStrategy } from '../../src/server/modules/strategy/strategies/low-per-high-roe-rank.js';

const sqlite = new Database(process.argv[2]!, { readonly: true });
const db = drizzle(sqlite, { schema });
const candles = new CandleCoverageService(db);
const facts = new SqliteFactRepository(db);
const symbols = Array.from({ length: 275 }, (_, index) => String(index).padStart(6, '0'));
const input = {
  strategy: lowPerHighRoeRankStrategy,
  parameters: { topN: 40, staleQuarters: 2 },
  period: { from: '2016-08-01', to: '2026-09-12' },
  schedule: Array.from({ length: 122 }, (_, index) => ({
    rebalanceDate: new Date(Date.UTC(2016, 7 + index, 1)).toISOString().slice(0, 10),
    symbols: Array.from({ length: 50 }, (_, offset) => symbols[(index * 3 + offset) % symbols.length]!),
  })),
};
let maxFactBatch = 0;
const readFacts = facts.getFacts.bind(facts);
facts.getFacts = (query) => {
  maxFactBatch = Math.max(maxFactBatch, query.keys?.length ?? 0);
  return readFacts(query);
};
let result;
if (process.argv[3] === 'legacy') {
  result = findIncompleteFundamentalCheckpoints({
    ...input,
    facts: await facts.getFacts({ scope: 'SYMBOL', keys: symbols }),
    validDatesBySymbol: candles.getValidDatesByCodeBetween(symbols, input.period.from, input.period.to),
  });
} else {
  // 새 경로가 전체 날짜 조회를 다시 호출하면 메모리 수치와 관계없이 실패시킨다.
  candles.getValidDatesByCodeBetween = () => { throw new Error('전체기간 날짜 적재 금지'); };
  result = await findIncompleteFundamentalCheckpointsFromCoverage({ ...input, candles, facts });
  const syncResult = findIncompleteFundamentalCheckpointsFromCoverageSync({
    ...input,
    candles,
    readFacts: (query) => sqlite.prepare(
      `SELECT scope, key, field, period_key AS periodKey, as_of_ts_ms AS asOfTsMs, value, unit
       FROM facts WHERE scope = 'SYMBOL' AND key IN (${query.keys!.map(() => '?').join(',')})
       AND as_of_ts_ms <= ?`,
    ).all(...query.keys!, query.asOfMaxTsMs!) as Awaited<ReturnType<typeof readFacts>>,
  });
  if (JSON.stringify(result) !== JSON.stringify(syncResult)) throw new Error('동기 검증 결과 불일치');
}
sqlite.close();
process.send?.({
  incomplete: result.length,
  hash: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  maxFactBatch,
  maxRssMiB: process.resourceUsage().maxRSS / 1024,
}, () => process.disconnect());
