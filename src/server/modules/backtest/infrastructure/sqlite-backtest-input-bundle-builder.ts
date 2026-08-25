import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../../../shared/db/database.js';
import type { LegacyUniverseScheduleEntry } from '../application/universe-rule-resolver.js';

/**
 * 운영 DB에서 한 job 실행에 필요한 행만 새 SQLite 파일로 복사한다.
 * auth/session/audit/notification 및 다른 job/result는 절대 복사하지 않는다.
 */
export class SqliteBacktestInputBundleBuilder {
  build(sourceDatabasePath: string, destinationPath: string, jobId: string): void {
    if (fs.existsSync(destinationPath)) {
      throw new Error(`입력 bundle 대상이 이미 존재합니다: ${destinationPath}`);
    }
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });

    const source = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });
    let schedule: LegacyUniverseScheduleEntry[];
    try {
      source.pragma('query_only = ON');
      const row = source.prepare(
        'SELECT universe_schedule_json AS universeScheduleJson FROM backtest_jobs WHERE id = ?',
      ).get(jobId) as { universeScheduleJson: string } | undefined;
      if (row === undefined) throw new Error(`job not found: ${jobId}`);
      schedule = JSON.parse(row.universeScheduleJson) as LegacyUniverseScheduleEntry[];
    } finally {
      source.close();
    }

    const symbols = [...new Set(schedule.flatMap((entry) => entry.symbols))].sort();
    const pinnedStandardCodes = [...new Set(schedule.flatMap((entry) =>
      entry.members?.map((member) => member.standardCode) ?? [],
    ))].sort();
    if (symbols.length === 0) throw new Error(`job에 실행할 종목이 없습니다: ${jobId}`);

    const destination = openDatabase(destinationPath);
    try {
      const sqlite = destination.sqlite;
      sqlite.exec('PRAGMA trusted_schema = OFF');
      sqlite.prepare('ATTACH DATABASE ? AS source').run(sourceDatabasePath);
      try {
        const copy = sqlite.transaction(() => {
          sqlite.exec('CREATE TEMP TABLE bundle_symbols (code TEXT PRIMARY KEY NOT NULL)');
          sqlite.exec('CREATE TEMP TABLE bundle_standard_codes (code TEXT PRIMARY KEY NOT NULL)');
          const insertSymbol = sqlite.prepare('INSERT INTO bundle_symbols (code) VALUES (?)');
          for (const symbol of symbols) insertSymbol.run(symbol);
          const insertStandard = sqlite.prepare(
            'INSERT INTO bundle_standard_codes (code) VALUES (?) ON CONFLICT DO NOTHING',
          );
          for (const standardCode of pinnedStandardCodes) insertStandard.run(standardCode);
          // legacy schedule 추론과 short 재사용 검증에 필요한 선택 short의 모든
          // standard를 포함한다. 아래 master 복사는 이 표준코드의 다른 short alias도
          // 가져오므로 원격 child가 역방향 충돌을 잃지 않는다.
          sqlite.exec(`
            INSERT OR IGNORE INTO bundle_standard_codes (code)
            SELECT DISTINCT value.standard_code
            FROM source.symbol_master_versions AS value
            JOIN bundle_symbols AS wanted ON wanted.code = value.short_code;
          `);

          // 스키마는 같은 release가 만들고 소비하므로 컬럼 순서도 같다. job은 정확히 한 행만 복사한다.
          sqlite.prepare(
            'INSERT INTO main.backtest_jobs SELECT * FROM source.backtest_jobs WHERE id = ?',
          ).run(jobId);
          sqlite.exec(`
            INSERT INTO main.symbols
            SELECT value.* FROM source.symbols AS value
            WHERE value.code IN (SELECT code FROM bundle_symbols)
               OR value.standard_code IN (SELECT code FROM bundle_standard_codes);

            INSERT INTO main.symbol_versions
            SELECT value.* FROM source.symbol_versions AS value
            JOIN bundle_symbols AS wanted ON wanted.code = value.code;

            INSERT INTO main.krx_daily_bars
            SELECT value.* FROM source.krx_daily_bars AS value
            JOIN bundle_symbols AS wanted ON wanted.code = value.short_code;

            INSERT INTO main.facts
            SELECT value.* FROM source.facts AS value
            JOIN bundle_symbols AS wanted ON wanted.code = value.key
            WHERE value.scope = 'SYMBOL';

            -- worker의 자본변동 fail-closed 검사는 raw fact가 없는 parser gap도 알아야
            -- 한다. 선택 종목의 coverage/gap 상태만 복사하고 다른 종목 상태는 제외한다.
            INSERT INTO main.symbol_facts_state
            SELECT value.* FROM source.symbol_facts_state AS value
            JOIN bundle_symbols AS wanted ON wanted.code = value.code;

            DELETE FROM main.symbol_master_storage_state;
            INSERT INTO main.symbol_master_storage_state
            SELECT * FROM source.symbol_master_storage_state;

            -- child가 기간 중 상장폐지·종목 변경 누락을 fail-closed로 확인한다.
            -- coverage는 전역 날짜 수집 상태라 선택 종목으로 좁힐 축이 없다.
            INSERT INTO main.symbol_master_coverage
            SELECT * FROM source.symbol_master_coverage;

            INSERT INTO main.symbol_master_trading_days
            SELECT * FROM source.symbol_master_trading_days;

            INSERT INTO main.symbol_master_versions
            SELECT value.* FROM source.symbol_master_versions AS value
            WHERE value.short_code IN (SELECT code FROM bundle_symbols)
               OR value.standard_code IN (SELECT code FROM bundle_standard_codes)
            ORDER BY value.standard_code, value.valid_from_date;

            INSERT INTO main.krx_non_trading_days
            SELECT value.* FROM source.krx_non_trading_days AS value
            JOIN bundle_symbols AS wanted ON wanted.code = value.short_code;

            INSERT INTO main.krx_non_trading_coverage
            SELECT * FROM source.krx_non_trading_coverage;
          `);

          // Worker는 원문 lease를 이미 갖고 있다. bundle에는 검증용 hash조차 남길 이유가 없다.
          sqlite.prepare(
            `UPDATE main.backtest_jobs
             SET lease_token_hash = NULL, lease_expires_at_ms = NULL`,
          ).run();
        });
        // source 운영 DB에는 읽기 snapshot만 필요하다. IMMEDIATE는 attached source에도
        // 불필요한 write 예약을 걸 수 있으므로 destination write + source read의 DEFERRED
        // transaction으로 유지한다.
        copy();
      } finally {
        sqlite.exec('DETACH DATABASE source');
      }
      sqlite.pragma('journal_mode = DELETE');
      sqlite.exec('VACUUM');
      fs.chmodSync(destinationPath, 0o600);
    } catch (error) {
      destination.close();
      fs.rmSync(destinationPath, { force: true });
      throw error;
    }
    destination.close();
  }
}
