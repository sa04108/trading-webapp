import { and, asc, eq, inArray, like, lte, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { facts as factRows } from '../../../shared/db/schema.js';
import { SYMBOL_PATTERN } from '../../market-data/domain/candle.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../domain/fact.js';
import type { FactQuery, FactRepository } from '../application/ports.js';

// 7개 컬럼을 쓰므로 SQLite의 보수적인 999 bind 한도 아래에서 자른다.
const WRITE_BATCH_SIZE = 100;
const READ_KEY_BATCH_SIZE = 500;

/** SQLite의 복합 PK와 UPSERT를 그대로 쓰는 FactRepository. */
export class SqliteFactRepository implements FactRepository {
  constructor(private readonly db: AppDatabase) {}

  async saveFacts(facts: readonly Fact[]): Promise<void> {
    if (facts.length === 0) return;
    validateFacts(facts);

    this.db.transaction((tx) => {
      for (let index = 0; index < facts.length; index += WRITE_BATCH_SIZE) {
        tx.insert(factRows)
          .values(facts.slice(index, index + WRITE_BATCH_SIZE))
          .onConflictDoUpdate({
            target: [
              factRows.scope,
              factRows.key,
              factRows.field,
              factRows.periodKey,
              factRows.asOfTsMs,
            ],
            set: { value: sql`excluded.value`, unit: sql`excluded.unit` },
          })
          .run();
      }
    });
  }

  async replaceSymbolFinancialFactsForYear(
    symbol: string,
    year: number,
    facts: readonly Fact[],
  ): Promise<void> {
    if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`invalid symbol key: ${symbol}`);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      throw new Error(`invalid financial fact year: ${year}`);
    }
    validateFacts(facts);
    const prefix = String(year);
    for (const fact of facts) {
      if (
        fact.scope !== 'SYMBOL'
        || fact.key !== symbol
        || fact.field === CORPORATE_ACTION_FIELD
        || !fact.periodKey.startsWith(prefix)
      ) {
        throw new Error(
          `재무 snapshot 범위를 벗어난 팩트입니다: ${fact.scope}/${fact.key}/${fact.field}/${fact.periodKey}`,
        );
      }
    }

    this.db.transaction((tx) => {
      tx.delete(factRows)
        .where(and(
          eq(factRows.scope, 'SYMBOL'),
          eq(factRows.key, symbol),
          ne(factRows.field, CORPORATE_ACTION_FIELD),
          like(factRows.periodKey, `${year}%`),
        ))
        .run();
      for (let index = 0; index < facts.length; index += WRITE_BATCH_SIZE) {
        tx.insert(factRows).values(facts.slice(index, index + WRITE_BATCH_SIZE)).run();
      }
    });
  }

  async replaceSymbolCorporateActionFactsForYear(
    symbol: string,
    year: number,
    facts: readonly Fact[],
  ): Promise<void> {
    if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`invalid symbol key: ${symbol}`);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      throw new Error(`invalid corporate action fact year: ${year}`);
    }
    validateFacts(facts);
    const prefix = String(year);
    for (const fact of facts) {
      if (
        fact.scope !== 'SYMBOL'
        || fact.key !== symbol
        || fact.field !== CORPORATE_ACTION_FIELD
        || !fact.periodKey.startsWith(prefix)
      ) {
        throw new Error(
          `자본변동 snapshot 범위를 벗어난 팩트입니다: `
            + `${fact.scope}/${fact.key}/${fact.field}/${fact.periodKey}`,
        );
      }
    }

    this.db.transaction((tx) => {
      tx.delete(factRows)
        .where(and(
          eq(factRows.scope, 'SYMBOL'),
          eq(factRows.key, symbol),
          eq(factRows.field, CORPORATE_ACTION_FIELD),
          like(factRows.periodKey, `${year}%`),
        ))
        .run();
      for (let index = 0; index < facts.length; index += WRITE_BATCH_SIZE) {
        tx.insert(factRows).values(facts.slice(index, index + WRITE_BATCH_SIZE)).run();
      }
    });
  }

  async getFacts(query: FactQuery): Promise<Fact[]> {
    const keys = query.keys && query.keys.length > 0 ? [...new Set(query.keys)] : null;
    const batches: Array<readonly string[] | null> = keys === null
      ? [null]
      : Array.from(
          { length: Math.ceil(keys.length / READ_KEY_BATCH_SIZE) },
          (_, index) => keys.slice(index * READ_KEY_BATCH_SIZE, (index + 1) * READ_KEY_BATCH_SIZE),
        );
    const rows: Fact[] = [];

    for (const batch of batches) {
      const conditions = [eq(factRows.scope, query.scope)];
      if (batch !== null) conditions.push(inArray(factRows.key, batch));
      if (query.fields && query.fields.length > 0) {
        conditions.push(inArray(factRows.field, query.fields));
      }
      if (query.asOfMaxTsMs !== undefined) {
        conditions.push(lte(factRows.asOfTsMs, query.asOfMaxTsMs));
      }
      rows.push(...this.db
        .select()
        .from(factRows)
        .where(and(...conditions))
        .orderBy(
          asc(factRows.key),
          asc(factRows.field),
          asc(factRows.periodKey),
          asc(factRows.asOfTsMs),
        )
        .all() as Fact[]);
    }

    return rows.sort(compareFacts);
  }

}

function validateFacts(facts: readonly Fact[]): void {
  for (const fact of facts) {
    if (fact.scope === 'SYMBOL' && !SYMBOL_PATTERN.test(fact.key)) {
      throw new Error(`invalid symbol key: ${fact.key}`);
    }
    if (!Number.isFinite(fact.value)) {
      throw new Error(
        `팩트 값이 유한하지 않습니다: key=${fact.key}, field=${fact.field}, `
          + `periodKey=${fact.periodKey}, value=${fact.value}`,
      );
    }
    if (!Number.isFinite(fact.asOfTsMs)) {
      throw new Error(
        `팩트 asOfTsMs가 유한하지 않습니다: key=${fact.key}, field=${fact.field}, `
          + `periodKey=${fact.periodKey}, asOfTsMs=${fact.asOfTsMs}`,
      );
    }
  }
}

function compareFacts(left: Fact, right: Fact): number {
  return compareText(left.key, right.key)
    || compareText(left.field, right.field)
    || compareText(left.periodKey, right.periodKey)
    || left.asOfTsMs - right.asOfTsMs;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
