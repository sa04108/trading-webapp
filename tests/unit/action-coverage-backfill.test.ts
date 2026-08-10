import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { symbolFactsState, symbols as symbolsTable } from '../../src/server/shared/db/schema.js';

/**
 * `0010_action_coverage_backfill.sql` 이 기존 종목의 자본변동 커버리지를 채운다.
 *
 * 이 브랜치 전에는 재무와 자본변동을 항상 함께 받아 `covered_years_json` 한 곳에만
 * 적었다. 그래서 그 시절의 재무 커버리지가 곧 자본변동 커버리지다.
 * 채우지 않으면 배포 첫날 모든 제출이 게이트에 걸려 400 이 된다.
 *
 * 테스트는 마이그레이션 파일의 SQL 을 그대로 읽어 실행한다.
 * 문장을 여기 옮겨 적으면 파일이 바뀌어도 이 테스트가 계속 통과해버린다.
 */
const MIGRATION_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
  '0010_action_coverage_backfill.sql',
);

describe('0010 자본변동 커버리지 백필', () => {
  it('journal 에 등재돼 있다 — 파일만 두면 배포에서 실행되지 않는다', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.resolve(MIGRATION_PATH, '..', 'meta', '_journal.json'), 'utf-8'),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((entry) => entry.tag)).toContain('0010_action_coverage_backfill');
  });

  it('`action_covered_years_json` 이 비어 있으면 재무 커버리지로 채운다', async () => {
    const t = await createTestApp();
    const db = t.container.database.db;
    db.insert(symbolsTable)
      .values([
        { code: '005930', market: 'KR', name: null, createdAtMs: 1 },
        { code: '000660', market: 'KR', name: null, createdAtMs: 1 },
        { code: '035720', market: 'KR', name: null, createdAtMs: 1 },
      ])
      .run();

    // 마이그레이션 이전에 만들어진 행 — 자본변동 컬럼이 비어 있다
    db.insert(symbolFactsState)
      .values({ code: '005930', coveredYearsJson: '[2024,2025,2026]', updatedAtMs: 1 })
      .run();
    // 이미 자본변동을 따로 받은 행 — 덮어쓰면 안 된다
    db.insert(symbolFactsState)
      .values({
        code: '000660',
        coveredYearsJson: '[2024,2025]',
        actionCoveredYearsJson: '[2026]',
        updatedAtMs: 1,
      })
      .run();
    // 재무를 하나도 받지 않은 행 — 빈 목록이 그대로 옮겨 간다
    db.insert(symbolFactsState)
      .values({ code: '035720', coveredYearsJson: '[]', updatedAtMs: 1 })
      .run();

    t.container.database.sqlite.exec(fs.readFileSync(MIGRATION_PATH, 'utf-8'));

    const read = (code: string) =>
      db.select().from(symbolFactsState).where(eq(symbolFactsState.code, code)).get();

    expect(read('005930')?.actionCoveredYearsJson).toBe('[2024,2025,2026]');
    expect(read('000660')?.actionCoveredYearsJson).toBe('[2026]');
    expect(read('035720')?.actionCoveredYearsJson).toBe('[]');
    // 재무 커버리지는 그대로다
    expect(read('005930')?.coveredYearsJson).toBe('[2024,2025,2026]');

    await t.close();
  });

  it('백필된 종목은 게이트를 통과한다 — 배포 첫날 전원 400 을 막는다', async () => {
    const t = await createTestApp();
    const db = t.container.database.db;
    db.insert(symbolsTable)
      .values([{ code: '005930', market: 'KR', name: null, createdAtMs: 1 }])
      .run();
    db.insert(symbolFactsState)
      .values({ code: '005930', coveredYearsJson: '[2025,2026]', updatedAtMs: 1 })
      .run();
    // coverage 는 parquet 실체와 교차 확인해서만 읽힌다 — 시도의 실체를 함께 심는다.
    await t.container.factRepository.ensurePartition('SYMBOL', '005930');

    const store = t.container.actionCoverageStore;
    // 백필 전에는 미수집으로 보인다 — `parseYears(null)` 이 빈 목록이라 그렇다
    expect(store.getCoveredYears(['005930']).get('005930')).toEqual([]);

    t.container.database.sqlite.exec(fs.readFileSync(MIGRATION_PATH, 'utf-8'));

    expect(store.getCoveredYears(['005930']).get('005930')).toEqual([2025, 2026]);

    await t.close();
  });
});
