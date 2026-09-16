import { describe, expect } from 'vitest';
import { test as it } from '../helpers/test-fixtures.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';

describe('krx_daily_bars 스키마', () => {
  it('삽입·조회가 왕복한다', async ({ ctx: t }) => {
    const db = t.container.database.db;

    db.insert(krxDailyBars).values({
      shortCode: '005930',
      date: '2023-01-02',
      market: 'KOSPI',
      open: 71_500,
      high: 72_000,
      low: 71_000,
      close: 71_800,
      volume: 12_345_678,
    }).run();

    const rows = db.select().from(krxDailyBars).all();
    expect(rows).toEqual([
      {
        shortCode: '005930',
        date: '2023-01-02',
        market: 'KOSPI',
        open: 71_500,
        high: 72_000,
        low: 71_000,
        close: 71_800,
        volume: 12_345_678,
      },
    ]);

  });

  it('(shortCode, date) 가 같으면 덮어쓴다', async ({ ctx: t }) => {
    const db = t.container.database.db;

    db.insert(krxDailyBars).values({
      shortCode: '005930',
      date: '2023-01-02',
      market: 'KOSPI',
      open: 71_500,
      high: 72_000,
      low: 71_000,
      close: 71_800,
      volume: 12_345_678,
    }).run();

    db.insert(krxDailyBars).values({
      shortCode: '005930',
      date: '2023-01-02',
      market: 'KOSPI',
      open: 71_600,
      high: 72_100,
      low: 71_100,
      close: 71_900,
      volume: 9_999_999,
    }).onConflictDoUpdate({
      target: [krxDailyBars.shortCode, krxDailyBars.date],
      set: {
        market: 'KOSPI',
        open: 71_600,
        high: 72_100,
        low: 71_100,
        close: 71_900,
        volume: 9_999_999,
      },
    }).run();

    const rows = db.select().from(krxDailyBars).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ open: 71_600, volume: 9_999_999 });

  });
});
