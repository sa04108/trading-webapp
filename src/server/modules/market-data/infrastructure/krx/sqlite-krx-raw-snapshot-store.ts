import { parseKrxEnvelope } from "./krx-contract.js";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../../../../../runtime/shared/db/database.js";
import { krxRawApiSnapshots } from "../../../../shared/db/collection-schema.js";
import {
  KrxRawSnapshotCorruptError,
  type KrxRawSnapshot,
  type KrxRawSnapshotKey,
  type KrxRawSnapshotStore,
} from "./krx-raw-snapshot-store.js";

function hash(key: KrxRawSnapshotKey, value: string): string {
  return createHash("sha256").update(JSON.stringify([key.namespace, key.endpoint, key.basDd, value])).digest("hex");
}

/** 원문 이력을 덮어쓰지 않고 보존하며 정상인 최신 로컬 사본을 재생한다. */
export class SqliteKrxRawSnapshotStore implements KrxRawSnapshotStore {
  constructor(private readonly db: AppDatabase) {}

  get(key: KrxRawSnapshotKey): KrxRawSnapshot | null {
    const rows = this.db.select().from(krxRawApiSnapshots).where(and(
      eq(krxRawApiSnapshots.namespace, key.namespace),
      eq(krxRawApiSnapshots.endpoint, key.endpoint),
      eq(krxRawApiSnapshots.basDd, key.basDd),
    )).orderBy(desc(krxRawApiSnapshots.id)).all();
    if (rows.length === 0) return null;
    const expectedHash = rows[0]!.contentHash;
    for (const row of rows) {
      // 이전 정정본으로 되돌리지 않고 최신 원문과 같은 내용의 로컬 사본만 복구한다.
      if (row.contentHash !== expectedHash) continue;
      if (hash(key, row.payloadJson) !== row.contentHash) continue;
      try {
        const payload: unknown = JSON.parse(row.payloadJson);
        parseKrxEnvelope(payload);
        return { payload, fetchedAtMs: row.fetchedAtMs };
      } catch {
        // 훼손된 기록도 복구 근거이므로 삭제하지 않는다.
      }
    }
    throw new KrxRawSnapshotCorruptError(key, `KRX 원문 검증 실패:${hash(key, JSON.stringify(rows.map((row) => [row.id, row.contentHash, hash(key, row.payloadJson)])))}`);
  }

  put(key: KrxRawSnapshotKey, payload: unknown, fetchedAtMs: number): void {
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) throw new Error("KRX 원문을 JSON으로 직렬화할 수 없습니다.");
    this.db.insert(krxRawApiSnapshots).values({
      ...key, payloadJson, contentHash: hash(key, payloadJson), fetchedAtMs,
    }).run();
  }
}
