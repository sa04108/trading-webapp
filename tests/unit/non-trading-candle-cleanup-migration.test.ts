import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

const SOURCE_MIGRATIONS = path.resolve('migrations');

interface MigrationJournal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: ReadonlyArray<{
    readonly idx: number;
    readonly version: string;
    readonly when: number;
    readonly tag: string;
    readonly breakpoints: boolean;
  }>;
}

describe('거래불가 일봉 정리 migration', () => {
  it('0015 DB를 0016으로 올릴 때 확인된 0원 OHLC 행만 삭제한다', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-migration-'));
    const migrationsFolder = path.join(tempRoot, 'migrations');
    fs.cpSync(SOURCE_MIGRATIONS, migrationsFolder, { recursive: true });

    const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
    const fullJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal;
    expect(fullJournal.entries.find((entry) => entry.idx === 16)).toMatchObject({
      idx: 16,
      tag: '0016_cleanup_non_trading_bars',
    });

    const through0015: MigrationJournal = {
      ...fullJournal,
      entries: fullJournal.entries.filter((entry) => entry.idx <= 15),
    };
    fs.writeFileSync(journalPath, JSON.stringify(through0015, null, 2));

    const sqlite = new Database(path.join(tempRoot, 'app.sqlite'));
    const db = drizzle(sqlite);
    try {
      migrate(db, { migrationsFolder });
      sqlite.exec(`
        INSERT INTO krx_daily_bars VALUES
          ('TARGET', '2023-12-28', 'KOSPI', 0, 0, 0, 3585, 0),
          ('NO_FACT', '2023-12-28', 'KOSPI', 0, 0, 0, 9340, 0),
          ('NORMAL', '2023-12-28', 'KOSPI', 100, 110, 90, 105, 1000),
          ('ZERO_CLOSE', '2023-12-28', 'KOSPI', 0, 0, 0, 0, 0);
        INSERT INTO krx_non_trading_days (date, short_code, market, last_close) VALUES
          ('2023-12-28', 'TARGET', 'KOSPI', 3585),
          ('2023-12-28', 'NORMAL', 'KOSPI', 105),
          ('2023-12-28', 'ZERO_CLOSE', 'KOSPI', 0);
      `);

      fs.writeFileSync(journalPath, JSON.stringify(fullJournal, null, 2));
      migrate(db, { migrationsFolder });

      const remaining = sqlite.prepare(
        'SELECT short_code FROM krx_daily_bars ORDER BY short_code',
      ).all() as Array<{ short_code: string }>;
      expect(remaining.map((row) => row.short_code)).toEqual(['NORMAL', 'NO_FACT', 'ZERO_CLOSE']);
    } finally {
      sqlite.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
