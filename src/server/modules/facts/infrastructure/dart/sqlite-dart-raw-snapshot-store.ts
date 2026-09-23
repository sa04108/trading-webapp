import { createHash } from "node:crypto";
import { and, eq, inArray, min, or, sql } from "drizzle-orm";
import type { AppDatabase } from "../../../../../runtime/shared/db/database.js";
import { dartRawApiSnapshots } from "../../../../shared/db/collection-schema.js";
import type { DartReportCode } from "./dart-report-parser.js";
import {
  DartRawSnapshotError,
  dartRawSnapshotKeyId,
  type DartRawSnapshot,
  type DartRawSnapshotEndpoint,
  type DartRawSnapshotKey,
  type DartRawSnapshotStore,
} from "./dart-raw-snapshot-store.js";

/** 응답 JSON과 해시를 함께 저장해 손상된 cache를 원천 응답으로 오인하지 않게 한다. */
export class SqliteDartRawSnapshotStore implements DartRawSnapshotStore {
  constructor(private readonly db: AppDatabase) {}

  getOldestFetchedAtMs(
    symbols: readonly string[],
  ): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    const unique = [...new Set(symbols)];
    for (let offset = 0; offset < unique.length; offset += 500) {
      const rows = this.db
        .select({
          code: dartRawApiSnapshots.code,
          fetchedAtMs: min(dartRawApiSnapshots.fetchedAtMs),
        })
        .from(dartRawApiSnapshots)
        .where(
          inArray(dartRawApiSnapshots.code, unique.slice(offset, offset + 500)),
        )
        .groupBy(dartRawApiSnapshots.code)
        .all();
      for (const row of rows) {
        if (row.fetchedAtMs !== null) result.set(row.code, row.fetchedAtMs);
      }
    }
    return result;
  }

  get(key: DartRawSnapshotKey): DartRawSnapshot | null {
    return this.parseRow(
      this.db
        .select()
        .from(dartRawApiSnapshots)
        .where(
          and(
            eq(dartRawApiSnapshots.code, key.symbol),
            eq(dartRawApiSnapshots.endpoint, key.endpoint),
            eq(dartRawApiSnapshots.businessYear, key.businessYear),
            eq(dartRawApiSnapshots.reportCode, key.reportCode),
            eq(dartRawApiSnapshots.fsDiv, key.fsDiv),
          ),
        )
        .get(),
    );
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
        .where(
          or(
            ...batch.map((key) =>
              and(
                eq(dartRawApiSnapshots.code, key.symbol),
                eq(dartRawApiSnapshots.endpoint, key.endpoint),
                eq(dartRawApiSnapshots.businessYear, key.businessYear),
                eq(dartRawApiSnapshots.reportCode, key.reportCode),
                eq(dartRawApiSnapshots.fsDiv, key.fsDiv),
              ),
            ),
          ),
        )
        .all();
      const byKey = new Map(
        rows.map((row) => [
          dartRawSnapshotKeyId({
            symbol: row.code,
            endpoint: row.endpoint as DartRawSnapshotEndpoint,
            businessYear: row.businessYear,
            reportCode: row.reportCode as DartReportCode,
            fsDiv: row.fsDiv as DartRawSnapshotKey["fsDiv"],
          }),
          row,
        ]),
      );
      for (const key of batch) {
        const snapshot = this.parseRow(byKey.get(dartRawSnapshotKeyId(key)));
        if (snapshot === null) missing += 1;
        else if (!isValidPayload(snapshot.payload))
          throw new DartRawSnapshotError("PARSER_INCOMPATIBLE", dartRawSnapshotKeyId(key));
      }
    }
    return missing;
  }

  private parseRow(
    row: typeof dartRawApiSnapshots.$inferSelect | undefined,
  ): DartRawSnapshot | null {
    if (row === undefined) return null;
    const key = `${row.code}:${row.endpoint}:${row.businessYear}:${row.reportCode}:${row.fsDiv}`;
    if (hash(row.payloadJson) !== row.contentHash) {
      // 현재 원문이 기대하는 바로 그 해시만 과거 보존본에서 복구한다. 더 오래된 다른 값으로 대체하지 않는다.
      const archived = this.db.get<{ snapshot_json: string }>(sql`SELECT snapshot_json
        FROM dart_raw_api_snapshot_history WHERE json_extract(snapshot_json, '$.contentHash') = ${row.contentHash}
        AND json_extract(snapshot_json, '$.code') = ${row.code}
        AND json_extract(snapshot_json, '$.endpoint') = ${row.endpoint}
        AND json_extract(snapshot_json, '$.businessYear') = ${row.businessYear}
        AND json_extract(snapshot_json, '$.reportCode') = ${row.reportCode}
        AND json_extract(snapshot_json, '$.fsDiv') = ${row.fsDiv} ORDER BY id DESC LIMIT 1`);
      if (archived !== undefined) {
        try {
          const prior = JSON.parse(archived.snapshot_json) as typeof row;
          if (hash(prior.payloadJson) === row.contentHash)
            return { payload: JSON.parse(prior.payloadJson) as unknown, fetchedAtMs: row.fetchedAtMs };
        } catch { /* 손상된 보존본은 복구 근거로 쓰지 않는다. */ }
      }
      throw new DartRawSnapshotError("HASH_MISMATCH", key, `${row.contentHash}:${hash(row.payloadJson)}`);
    }
    try {
      return {
        payload: JSON.parse(row.payloadJson) as unknown,
        fetchedAtMs: row.fetchedAtMs,
      };
    } catch {
      throw new DartRawSnapshotError("INVALID_JSON", key, row.contentHash);
    }
  }

  put(key: DartRawSnapshotKey, payload: unknown, fetchedAtMs: number): void {
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) {
      throw new Error("DART 원문 snapshot을 JSON으로 직렬화할 수 없습니다.");
    }
    const rows = typeof payload === "object" && payload !== null && "list" in payload && Array.isArray(payload.list)
      ? payload.list as unknown[] : [];
    let receiptNo: string | null = null;
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      if ("rcept_no" in row && typeof row.rcept_no === "string" && /^\d{14}$/.test(row.rcept_no) &&
          (receiptNo === null || row.rcept_no > receiptNo)) receiptNo = row.rcept_no;
    }
    this.db.transaction((tx) => {
      const previous = tx.select().from(dartRawApiSnapshots).where(and(
        eq(dartRawApiSnapshots.code, key.symbol),
        eq(dartRawApiSnapshots.endpoint, key.endpoint),
        eq(dartRawApiSnapshots.businessYear, key.businessYear),
        eq(dartRawApiSnapshots.reportCode, key.reportCode),
        eq(dartRawApiSnapshots.fsDiv, key.fsDiv),
      )).get();
      if (previous !== undefined) tx.run(sql`INSERT INTO dart_raw_api_snapshot_history
        (snapshot_json, archived_at_ms) VALUES (${JSON.stringify(previous)}, ${fetchedAtMs})`);
      tx
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
        receiptNo,
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
          receiptNo: sql`excluded.receipt_no`,
        },
      })
      .run();
    });
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
