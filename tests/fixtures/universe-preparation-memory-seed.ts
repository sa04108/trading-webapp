import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { CORPORATE_ACTION_COVERAGE_PROTOCOL_VERSION } from '../../src/runtime/modules/facts/application/corporate-action-coverage.js';
import { pathToFileURL } from 'node:url';

export const FIXTURE_COLLECTION_VERSION = 'a'.repeat(64);

/** 결정적 합성 데이터이며 실제 KRX 이력의 정확성을 주장하지 않는다. */
export function seedUniverseMemoryDatabase(databasePath: string): void {
  const handle = openDatabase(':memory:', { dataPath: databasePath });
  const db = handle.sqlite;
  try {
    db.prepare('INSERT INTO symbol_master_coverage (start_date, end_date, synced_at_ms, collection_version) VALUES (?, ?, 0, ?)').run('2015-01-01', '2025-12-31', FIXTURE_COLLECTION_VERSION);
    const dates: string[] = [];
    for (let ts = Date.parse('2015-01-01T00:00:00Z'); ts <= Date.parse('2025-12-31T00:00:00Z'); ts += 86_400_000) {
      const date = new Date(ts);
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
    }
    const tradingDay = db.prepare('INSERT INTO symbol_master_trading_days VALUES (?)');
    const version = db.prepare("INSERT INTO symbol_master_versions (standard_code,valid_from_date,valid_to_date,short_code,name,market,shares_outstanding,instrument_type,listed_date,recorded_at_ms) VALUES (?, ?, ?, ?, ?, 'KOSPI', ?, 'COMMON_STOCK', NULL, 0)");
    const symbol = db.prepare("INSERT INTO symbols (code,market,name,standard_code,created_at_ms) VALUES (?, 'KR', ?, ?, 0)");
    const state = db.prepare('INSERT INTO symbol_facts_state (code, covered_years_json, action_covered_years_json, action_coverage_protocol_json) VALUES (?, ?, ?, ?)');
    const bar = db.prepare("INSERT INTO krx_daily_bars VALUES (?, ?, 'KOSPI', ?, ?, ?, ?, 1000)");
    const metric = db.prepare('INSERT INTO daily_selection_metrics VALUES (?, ?, ?, 1000, ?)');
    const coverage = db.prepare('INSERT INTO daily_selection_metric_coverage (date,synced_at_ms,collection_version) VALUES (?, 0, ?)');
    const fact = db.prepare("INSERT INTO facts (scope,key,field,period_key,as_of_ts_ms,value,unit,corporate_action_before_shares,corporate_action_after_shares) VALUES ('SYMBOL', ?, 'SPLIT_RATIO', ?, ?, 2, 'ratio', NULL, NULL)");
    db.transaction(() => {
      for (const date of dates) tradingDay.run(date);
      for (let i = 0; i < 900; i += 1) {
        const code = String(i).padStart(6, '0');
        const standard = `KR${String(i).padStart(10, '0')}`;
        symbol.run(code, `종목${i}`, standard);
        const years = Array.from({ length: 14 }, (_, year) => 2014 + year);
        state.run(code, '[]', JSON.stringify(years), JSON.stringify({ version: CORPORATE_ACTION_COVERAGE_PROTOCOL_VERSION, collectionVersion: FIXTURE_COLLECTION_VERSION, years }));
        for (let q = -1; q < 40; q += 1) {
          const actionDate = (quarter: number) => `${2016 + Math.floor(quarter / 4)}-${String(quarter % 4 * 3 + 1).padStart(2, '0')}-15`;
          version.run(standard, q < 0 ? '2015-01-01' : actionDate(q), q === 39 ? null : actionDate(q + 1), code, `종목${i}`, String(2 ** (q + 1)));
        }
        for (const date of dates) {
          const close = 1000 + i + (Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000) % 89) * (i % 7 + 1);
          bar.run(code, date, close, close, close, close);
        }
        for (let month = 0; month < 120; month += 1) {
          const date = `${2016 + Math.floor(month / 12)}-${String(month % 12 + 1).padStart(2, '0')}-01`;
          const effective = new Date(`${date}T00:00:00Z`);
          while (effective.getUTCDay() === 0 || effective.getUTCDay() === 6) effective.setUTCDate(effective.getUTCDate() - 1);
          const effectiveDate = effective.toISOString().slice(0, 10);
          const rank = (i - month * 7 + 1800) % 900;
          metric.run(effectiveDate, standard, (9007199254740993000n + BigInt(900 - rank)).toString(), '100000');
          if (i === 0) coverage.run(effectiveDate, FIXTURE_COLLECTION_VERSION);
        }
        for (let quarter = 0; quarter < 40; quarter += 1) {
          const date = `${2016 + Math.floor(quarter / 4)}-${String(quarter % 4 * 3 + 1).padStart(2, '0')}-15`;
          fact.run(code, date, Date.parse(`${date}T00:00:00Z`));
        }
      }
    })();
  } finally { handle.close(); }
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('데이터베이스 경로가 필요합니다');
  seedUniverseMemoryDatabase(process.argv[2]);
}
