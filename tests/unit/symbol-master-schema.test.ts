import { and, asc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { symbolMasterVersions } from '../../src/server/shared/db/schema.js';
import { createTestApp } from '../helpers/test-app.js';

const SAMSUNG = {
  standardCode: 'KR7005930003',
  shortCode: '005930',
  name: '삼성전자',
  market: 'KOSPI',
  sharesOutstanding: '5969782550',
  instrumentType: 'COMMON_STOCK',
  listedDate: '1975-06-11',
  recordedAtMs: 1,
} as const;

describe('symbol_master_versions 스키마', () => {
  it('인접 버전을 허용하고 [validFromDate, validToDate) 경계에서 새 버전만 조회한다', async () => {
    const t = await createTestApp();
    try {
      const db = t.container.database.db;
      db.insert(symbolMasterVersions).values({
        ...SAMSUNG,
        validFromDate: '2023-01-02',
        validToDate: '2023-02-01',
      }).run();
      db.insert(symbolMasterVersions).values({
        ...SAMSUNG,
        name: '삼성전자 신명칭',
        validFromDate: '2023-02-01',
        validToDate: null,
        recordedAtMs: 2,
      }).run();

      const asOf = (date: string) => db
        .select()
        .from(symbolMasterVersions)
        .where(
          and(
            lte(symbolMasterVersions.validFromDate, date),
            or(isNull(symbolMasterVersions.validToDate), gt(symbolMasterVersions.validToDate, date)),
          ),
        )
        .orderBy(asc(symbolMasterVersions.validFromDate))
        .all();

      expect(asOf('2023-01-31').map((row) => row.name)).toEqual(['삼성전자']);
      expect(asOf('2023-02-01').map((row) => row.name)).toEqual(['삼성전자 신명칭']);
      expect(db.select().from(symbolMasterVersions).all()).toHaveLength(2);
    } finally {
      await t.close();
    }
  });

  it('빈 구간과 겹치는 INSERT를 데이터베이스 제약으로 거부한다', async () => {
    const t = await createTestApp();
    try {
      const db = t.container.database.db;
      db.insert(symbolMasterVersions).values({
        ...SAMSUNG,
        validFromDate: '2023-01-02',
        validToDate: '2023-02-01',
      }).run();

      expect(() => db.insert(symbolMasterVersions).values({
        ...SAMSUNG,
        standardCode: 'KR7000660001',
        shortCode: '000660',
        name: 'SK하이닉스',
        validFromDate: '2023-03-01',
        validToDate: '2023-03-01',
      }).run()).toThrow();

      expect(() => db.insert(symbolMasterVersions).values({
        ...SAMSUNG,
        validFromDate: '2023-01-15',
        validToDate: '2023-02-15',
      }).run()).toThrow(/interval overlap/);

      expect(db.select().from(symbolMasterVersions).all()).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it('UPDATE로 기존 기간과 겹치게 만드는 것도 거부한다', async () => {
    const t = await createTestApp();
    try {
      const db = t.container.database.db;
      db.insert(symbolMasterVersions).values({
        ...SAMSUNG,
        validFromDate: '2023-01-02',
        validToDate: '2023-02-01',
      }).run();
      db.insert(symbolMasterVersions).values({
        ...SAMSUNG,
        name: '삼성전자 신명칭',
        validFromDate: '2023-02-01',
        validToDate: null,
        recordedAtMs: 2,
      }).run();

      const current = db
        .select({ id: symbolMasterVersions.id })
        .from(symbolMasterVersions)
        .where(eq(symbolMasterVersions.validFromDate, '2023-02-01'))
        .get()!;

      expect(() => db
        .update(symbolMasterVersions)
        .set({ validFromDate: '2023-01-31' })
        .where(eq(symbolMasterVersions.id, current.id))
        .run()).toThrow(/interval overlap/);

      expect(db
        .select({ validFromDate: symbolMasterVersions.validFromDate })
        .from(symbolMasterVersions)
        .orderBy(asc(symbolMasterVersions.validFromDate))
        .all()).toEqual([
        { validFromDate: '2023-01-02' },
        { validFromDate: '2023-02-01' },
      ]);
    } finally {
      await t.close();
    }
  });
});
