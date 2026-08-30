import { createHash } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../../../shared/db/database.js';
import { dartRawApiSnapshots } from '../../../../shared/db/schema.js';
import type { DartReportCode } from './dart-report-parser.js';
import {
  dartRawSnapshotKeyId,
  type DartRawSnapshot,
  type DartRawSnapshotEndpoint,
  type DartRawSnapshotKey,
  type DartRawSnapshotStore,
} from './dart-raw-snapshot-store.js';

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

  countMissing(
    keys: readonly DartRawSnapshotKey[],
    isValidPayload: (payload: unknown) => boolean,
  ): number {
    let missing = 0;
    // 복합 키 하나가 bind 5개를 사용한다. 50개씩 조회해 구형 SQLite 한도 안에 두고,
    // 장기 원문 payload를 전부 메모리에 쌓지 않은 채 batch마다 즉시 검증·폐기한다.
    for (let offset = 0; offset < keys.length; offset += 50) {
      const batch = keys.slice(offset, offset + 50);
      if (batch.length === 0) continue;
      const rows = this.db
        .select()
        .from(dartRawApiSnapshots)
        .where(or(...batch.map((key) => and(
          eq(dartRawApiSnapshots.code, key.symbol),
          eq(dartRawApiSnapshots.endpoint, key.endpoint),
          eq(dartRawApiSnapshots.businessYear, key.businessYear),
          eq(dartRawApiSnapshots.reportCode, key.reportCode),
          eq(dartRawApiSnapshots.fsDiv, key.fsDiv),
        ))))
        .all();
      const byKey = new Map(rows.map((row) => [dartRawSnapshotKeyId({
        symbol: row.code,
        endpoint: row.endpoint as DartRawSnapshotEndpoint,
        businessYear: row.businessYear,
        reportCode: row.reportCode as DartReportCode,
        fsDiv: row.fsDiv as DartRawSnapshotKey['fsDiv'],
      }), row]));
      for (const key of batch) {
        const snapshot = this.parseRow(byKey.get(dartRawSnapshotKeyId(key)));
        if (snapshot === null || !isValidPayload(snapshot.payload)) missing += 1;
      }
    }
    return missing;
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
