import Database from 'better-sqlite3';
import { CORPORATE_ACTION_COVERAGE_PROTOCOL_VERSION } from '../../src/server/modules/facts/application/corporate-action-coverage.js';
import { DEFAULT_BENCHMARK_REQUEST } from './universe-benchmark-common.js';

const DAY_MS = 86_400_000;
// rsi-reversion의 correlation warm-up(60봉)과 보수 달력일 배수를 충분히 덮는다.
const DATA_FROM = '2016-01-01';
export const SYNTHETIC_FIXTURE_VERSION = '10y-rotating-market-cap-scd-actions-v1';

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let ts = Date.parse(`${from}T00:00:00Z`); ts <= Date.parse(`${to}T00:00:00Z`); ts += DAY_MS) {
    const date = new Date(ts);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

function monthlyRebalanceDates(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const anchorDay = start.getUTCDate();
  const result: string[] = [];
  for (let offset = 0; ; offset += 1) {
    const year = start.getUTCFullYear() + Math.floor((start.getUTCMonth() + offset) / 12);
    const month = (start.getUTCMonth() + offset) % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const date = new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay)))
      .toISOString().slice(0, 10);
    if (date > to) return result;
    result.push(date);
  }
}

function previousTradingDate(date: string, tradingDates: ReadonlySet<string>): string {
  let ts = Date.parse(`${date}T00:00:00Z`);
  for (;;) {
    const candidate = new Date(ts).toISOString().slice(0, 10);
    if (tradingDates.has(candidate)) return candidate;
    ts -= DAY_MS;
  }
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 실제 데이터 성능 근거가 아닌, 같은 10년·월별·200→50 형태의 scalable smoke fixture. */
export function seedSyntheticBenchmark(databasePath: string, symbolCount: number): void {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    const existing = (db.prepare('SELECT count(*) AS count FROM symbols').get() as { count: number }).count;
    const tradingDates = datesBetween(DATA_FROM, DEFAULT_BENCHMARK_REQUEST.period.to);
    const tradingSet = new Set(tradingDates);
    const effectiveDates = monthlyRebalanceDates(
      DEFAULT_BENCHMARK_REQUEST.period.from,
      DEFAULT_BENCHMARK_REQUEST.period.to,
    ).map((date) => previousTradingDate(date, tradingSet));
    const versionDates = tradingDates.filter((_, index) => index % 150 === 0);
    if (existing !== 0) {
      const count = (table: string, where = ''): number => (
        db.prepare(`SELECT count(*) AS count FROM ${table}${where}`).get() as { count: number }
      ).count;
      const actionSymbols = Math.ceil(symbolCount / 5);
      const actionsPerSymbol = Math.floor((versionDates.length - 1) / 2);
      const expected = {
        symbols: symbolCount,
        krx_daily_bars: symbolCount * tradingDates.length,
        symbol_master_versions: symbolCount * versionDates.length,
        daily_selection_metrics: symbolCount * effectiveDates.length,
        facts: actionSymbols * actionsPerSymbol,
      };
      const actual = {
        symbols: existing,
        krx_daily_bars: count('krx_daily_bars'),
        symbol_master_versions: count('symbol_master_versions'),
        daily_selection_metrics: count('daily_selection_metrics'),
        facts: count('facts', " WHERE field = 'SPLIT_RATIO'"),
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          '--synthetic-symbols 입력 DB가 빈 migrated DB도, 요청한 deterministic fixture도 아닙니다.',
        );
      }
      return;
    }
    // 20일 가격 실행창 앞뒤의 자본변동 정렬 window가 인접 연도를 넘을 수 있으므로
    // 요청 기간보다 양쪽 한 해씩 넓게 현재 protocol coverage를 심는다.
    const years = Array.from({ length: 13 }, (_, index) => 2015 + index);
    const actionProtocol = JSON.stringify({
      version: CORPORATE_ACTION_COVERAGE_PROTOCOL_VERSION,
      years,
    });
    const actionYears = JSON.stringify(years);
    const now = Date.parse('2026-09-03T00:00:00Z');
    // 약 7개월마다 SCD 경계를 만들어 2,000종목 기준 약 36k version을 만든다.
    // 5종목 중 1종목은 두 경계마다 실제 주식수도 2↔0.5로 바꾼다.

    const insertSymbol = db.prepare(
      'INSERT INTO symbols (code, market, name, standard_code, created_at_ms) VALUES (?, ?, ?, ?, ?)',
    );
    const insertVersion = db.prepare(
      'INSERT INTO symbol_master_versions '
      + '(standard_code, valid_from_date, valid_to_date, short_code, name, market, shares_outstanding, instrument_type, listed_date, recorded_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertFactState = db.prepare(
      'INSERT INTO symbol_facts_state '
      + '(code, covered_years_json, financial_coverage_protocol_json, action_covered_years_json, action_gap_years_json, '
      + 'action_gap_details_json, action_coverage_protocol_json, updated_at_ms, financial_updated_at_ms, action_updated_at_ms) '
      + 'VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)',
    );
    const insertTradingDate = db.prepare(
      'INSERT INTO symbol_master_trading_days (date) VALUES (?)',
    );
    const insertMetricCoverage = db.prepare(
      'INSERT INTO daily_selection_metric_coverage (date, synced_at_ms) VALUES (?, ?)',
    );
    const insertMetric = db.prepare(
      'INSERT INTO daily_selection_metrics (date, standard_code, market_cap_krw, volume, trading_value_krw) '
      + 'VALUES (?, ?, ?, ?, ?)',
    );
    const insertBar = db.prepare(
      'INSERT INTO krx_daily_bars (short_code, date, market, open, high, low, close, volume) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertAction = db.prepare(
      'INSERT INTO facts '
      + '(scope, key, field, period_key, as_of_ts_ms, value, unit, corporate_action_before_shares, corporate_action_after_shares) '
      + "VALUES ('SYMBOL', ?, 'SPLIT_RATIO', ?, ?, ?, 'RATIO', ?, ?)",
    );

    db.transaction(() => {
      db.prepare("UPDATE symbol_master_storage_state SET phase = 'ACTIVE', migrated_at_ms = ? WHERE singleton = 1")
        .run(now);
      db.prepare(
        'INSERT INTO symbol_master_coverage (start_date, end_date, synced_at_ms) VALUES (?, ?, ?)',
      ).run(DATA_FROM, DEFAULT_BENCHMARK_REQUEST.period.to, now);
      db.prepare(
        'INSERT INTO krx_non_trading_coverage (start_date, end_date, synced_at_ms) VALUES (?, ?, ?)',
      ).run(DATA_FROM, DEFAULT_BENCHMARK_REQUEST.period.to, now);

      for (const date of tradingDates) insertTradingDate.run(date);
      for (const date of new Set(effectiveDates)) insertMetricCoverage.run(date, now);

      for (let index = 0; index < symbolCount; index += 1) {
        const code = String(index + 1).padStart(6, '0');
        const standardCode = `KR7${String(index + 1).padStart(9, '0')}`;
        const name = `SYNTH-${code}`;
        insertSymbol.run(code, 'KR', name, standardCode, now);
        let shares = 1_000_000 + index * 2;
        const sharesByDate: Array<{ date: string; shares: number }> = [];
        for (let versionIndex = 0; versionIndex < versionDates.length; versionIndex += 1) {
          const validFrom = versionDates[versionIndex]!;
          const validTo = versionDates[versionIndex + 1] ?? null;
          const before = shares;
          if (index % 5 === 0 && versionIndex > 0 && versionIndex % 2 === 0) {
            shares = versionIndex % 4 === 2 ? before * 2 : before / 2;
            const rawDate = addDays(validFrom, -7);
            insertAction.run(
              code, rawDate, Date.parse(`${rawDate}T00:00:00Z`), shares / before, before, shares,
            );
          }
          sharesByDate.push({ date: validFrom, shares });
          insertVersion.run(
            standardCode, validFrom, validTo, code, `${name}-V${versionIndex}`, 'KOSDAQ',
            String(shares), 'COMMON_STOCK', DATA_FROM, now,
          );
        }
        insertFactState.run(code, '[]', actionYears, '[]', '[]', actionProtocol, now, now);
        let sharesIndex = 0;
        for (let dateIndex = 0; dateIndex < tradingDates.length; dateIndex += 1) {
          const date = tradingDates[dateIndex]!;
          while (
            sharesIndex + 1 < sharesByDate.length
            && sharesByDate[sharesIndex + 1]!.date <= date
          ) sharesIndex += 1;
          const currentShares = sharesByDate[sharesIndex]!.shares;
          const splitFactor = currentShares / (1_000_000 + index * 2);
          const adjusted = 10_000 + index * 10 + ((dateIndex + index * 7) % 40) - 20;
          const close = Math.max(1, Math.round(adjusted / splitFactor));
          insertBar.run(code, date, 'KOSDAQ', close, close, close, close, 1_000_000 + index);
        }
        for (let dateIndex = 0; dateIndex < effectiveDates.length; dateIndex += 1) {
          const date = effectiveDates[dateIndex]!;
          // 월별로 순위를 회전시켜 200개 DECLINE 후보가 10년 동안 전체 pool을 지난다.
          const rank = (index - dateIndex * 37 + symbolCount * 10) % symbolCount;
          const cap = BigInt(symbolCount - rank) * 1_000_000_000n + BigInt(dateIndex);
          insertMetric.run(date, standardCode, cap.toString(), 1_000_000 + index, cap.toString());
        }
      }
    })();
  } finally {
    db.close();
  }
}
