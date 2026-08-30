import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../../../shared/db/database.js';
import { dartRawApiSnapshots } from '../../../../shared/db/schema.js';
import type { DartReportCode } from './dart-report-parser.js';

export type DartRawSnapshotEndpoint =
  | 'FINANCIAL_STATEMENT'
  | 'SHARE_STATUS'
  | 'ISSUANCE_STATUS';

export interface DartRawSnapshotKey {
  readonly symbol: string;
  readonly endpoint: DartRawSnapshotEndpoint;
  readonly businessYear: number;
  readonly reportCode: DartReportCode;
  readonly fsDiv: 'CFS' | 'OFS' | 'NONE';
}

export interface DartRawSnapshot {
  readonly payload: unknown;
  readonly fetchedAtMs: number;
}

/** DART 원문 snapshot의 좁은 포트. API 어댑터는 SQLite 구현을 알지 않는다. */
export interface DartRawSnapshotStore {
  get(key: DartRawSnapshotKey): DartRawSnapshot | null;
  /** 입력 순서와 같은 위치에 snapshot/cache miss를 돌려준다. */
  getMany(keys: readonly DartRawSnapshotKey[]): readonly (DartRawSnapshot | null)[];
  put(key: DartRawSnapshotKey, payload: unknown, fetchedAtMs: number): void;
}

export function dartRawSnapshotKeyId(key: DartRawSnapshotKey): string {
  return [
    key.symbol,
    key.endpoint,
    key.businessYear,
    key.reportCode,
    key.fsDiv,
  ].join(':');
}

/** 응답 JSON과 해시를 함께 저장해 손상된 cache를 원천 응답으로 오인하지 않게 한다. */
export class SqliteDartRawSnapshotStore implements DartRawSnapshotStore {
  constructor(private readonly db: AppDatabase) {}

  get(key: DartRawSnapshotKey): DartRawSnapshot | null {
    return this.parseRow(this.db
      .select()
      .from(dartRawApiSnapshots)
      .where(and(
        eq(dartRawApiSnapshots.code, key.symbol),
        eq(dartRawApiSnapshots.endpoint, key.endpoint),
        eq(dartRawApiSnapshots.businessYear, key.businessYear),
        eq(dartRawApiSnapshots.reportCode, key.reportCode),
        eq(dartRawApiSnapshots.fsDiv, key.fsDiv),
      ))
      .get());
  }

  getMany(keys: readonly DartRawSnapshotKey[]): readonly (DartRawSnapshot | null)[] {
    if (keys.length === 0) return [];
    const requestedCodes = [...new Set(keys.map((key) => key.symbol))];
    const rows: Array<typeof dartRawApiSnapshots.$inferSelect> = [];
    for (let offset = 0; offset < requestedCodes.length; offset += 500) {
      rows.push(...this.db
        .select()
        .from(dartRawApiSnapshots)
        .where(inArray(dartRawApiSnapshots.code, requestedCodes.slice(offset, offset + 500)))
        .all());
    }
    const byKey = new Map(rows.map((row) => [dartRawSnapshotKeyId({
      symbol: row.code,
      endpoint: row.endpoint as DartRawSnapshotEndpoint,
      businessYear: row.businessYear,
      reportCode: row.reportCode as DartReportCode,
      fsDiv: row.fsDiv as DartRawSnapshotKey['fsDiv'],
    }), row]));
    return keys.map((key) => this.parseRow(byKey.get(dartRawSnapshotKeyId(key))));
  }

  private parseRow(
    row: typeof dartRawApiSnapshots.$inferSelect | undefined,
  ): DartRawSnapshot | null {
    if (row === undefined || hash(row.payloadJson) !== row.contentHash) return null;
    try {
      return { payload: JSON.parse(row.payloadJson) as unknown, fetchedAtMs: row.fetchedAtMs };
    } catch {
      return null;
    }
  }

  put(key: DartRawSnapshotKey, payload: unknown, fetchedAtMs: number): void {
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) {
      throw new Error('DART 원문 snapshot을 JSON으로 직렬화할 수 없습니다.');
    }
    this.db
      .insert(dartRawApiSnapshots)
      .values({
        code: key.symbol,
        endpoint: key.endpoint,
        businessYear: key.businessYear,
        reportCode: key.reportCode,
        fsDiv: key.fsDiv,
        payloadJson,
        contentHash: hash(payloadJson),
        fetchedAtMs,
      })
      .onConflictDoUpdate({
        target: [
          dartRawApiSnapshots.code,
          dartRawApiSnapshots.endpoint,
          dartRawApiSnapshots.businessYear,
          dartRawApiSnapshots.reportCode,
          dartRawApiSnapshots.fsDiv,
        ],
        set: {
          payloadJson: sql`excluded.payload_json`,
          contentHash: sql`excluded.content_hash`,
          fetchedAtMs: sql`excluded.fetched_at_ms`,
        },
      })
      .run();
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
