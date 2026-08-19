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

describe('재무·자본변동 watermark 분리 migration', () => {
  it('0024 DB의 공유 시각을 실제 커버리지가 있는 축에만 백필한다', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-watermark-migration-'));
    const migrationsFolder = path.join(tempRoot, 'migrations');
    fs.cpSync(SOURCE_MIGRATIONS, migrationsFolder, { recursive: true });

    const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
    const fullJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal;
    expect(fullJournal.entries.find((entry) => entry.idx === 25)).toMatchObject({
      idx: 25,
      tag: '0025_late_quicksilver',
    });
    const through0024: MigrationJournal = {
      ...fullJournal,
      entries: fullJournal.entries.filter((entry) => entry.idx <= 24),
    };
    fs.writeFileSync(journalPath, JSON.stringify(through0024, null, 2));

    const sqlite = new Database(path.join(tempRoot, 'app.sqlite'));
    const db = drizzle(sqlite);
    try {
      migrate(db, { migrationsFolder });
      sqlite.exec(`
        INSERT INTO symbols (code, market, created_at_ms) VALUES
          ('000001', 'KR', 1),
          ('000002', 'KR', 1),
          ('000003', 'KR', 1),
          ('000004', 'KR', 1);
        INSERT INTO symbol_facts_state (
          code,
          covered_years_json,
          updated_at_ms,
          action_covered_years_json,
          action_gap_years_json
        ) VALUES
          ('000001', '[2025]', 100, '[]', '[]'),
          ('000002', '[]', 200, '[2025]', '[]'),
          ('000003', '[2025]', 300, '[2025]', '[]'),
          ('000004', '[]', 400, '[]', '[]');
      `);

      fs.writeFileSync(journalPath, JSON.stringify(fullJournal, null, 2));
      migrate(db, { migrationsFolder });

      const rows = sqlite.prepare(`
        SELECT
          code,
          financial_updated_at_ms AS financial,
          action_updated_at_ms AS action
        FROM symbol_facts_state
        ORDER BY code
      `).all();
      expect(rows).toEqual([
        { code: '000001', financial: 100, action: null },
        { code: '000002', financial: null, action: 200 },
        { code: '000003', financial: 300, action: 300 },
        { code: '000004', financial: null, action: null },
      ]);
    } finally {
      sqlite.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
