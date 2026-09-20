import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { parseCorpCodeXml, type DartCorpCodeSnapshotStore } from "./dart-corp-code-cache.js";
import { DartRawSnapshotError } from "./dart-raw-snapshot-store.js";

/** 고유번호 원문을 운영 DB에 저장하고 재시작 후에도 동일 정체성을 재사용한다. */
export class SqliteDartCorpCodeSnapshotStore implements DartCorpCodeSnapshotStore {
  constructor(private readonly sqlite: Database.Database, private readonly namespace: string, private readonly onIdentityChanged?: (symbol: string, previousCorp: string, nextCorp: string) => void) {}

  get(): { xml: string; fetchedAtMs: number; changedSymbols: readonly string[] } | null {
    const row = this.sqlite.prepare("SELECT xml, content_hash, fetched_at_ms FROM dart_corp_code_snapshot WHERE namespace = ?")
      .get(this.namespace) as { xml: string; content_hash: string; fetched_at_ms: number } | undefined;
    if (row === undefined) return null;
    if (createHash("sha256").update(row.xml).digest("hex") !== row.content_hash)
      throw new DartRawSnapshotError("HASH_MISMATCH", "corpCode.xml");
    const map = parseCorpCodeXml(row.xml);
    const changed = new Set<string>();
    const history = this.sqlite.prepare(`SELECT snapshot_json FROM dart_raw_api_snapshot_history
      WHERE json_extract(snapshot_json, '$.kind') = 'CORP_CODE'
      AND json_extract(snapshot_json, '$.namespace') = ?`).all(this.namespace) as {snapshot_json: string}[];
    for (const entry of history) {
      const prior = JSON.parse(entry.snapshot_json) as {xml: string; contentHash: string};
      if (createHash("sha256").update(prior.xml).digest("hex") !== prior.contentHash)
        throw new DartRawSnapshotError("HASH_MISMATCH", "corpCode.xml history");
      for (const [symbol, previous] of parseCorpCodeXml(prior.xml))
        if (map.has(symbol) && map.get(symbol) !== previous) changed.add(symbol);
    }
    return { xml: row.xml, fetchedAtMs: row.fetched_at_ms, changedSymbols: [...changed] };
  }

  put(xml: string, fetchedAtMs: number): void {
    this.sqlite.transaction(() => {
    const previous = this.get();
    if (previous !== null) {
      this.sqlite.prepare("INSERT INTO dart_raw_api_snapshot_history (snapshot_json, archived_at_ms) VALUES (?, ?)")
        .run(JSON.stringify({kind:"CORP_CODE", namespace:this.namespace, xml:previous.xml,
          contentHash:createHash("sha256").update(previous.xml).digest("hex"), fetchedAtMs:previous.fetchedAtMs}), fetchedAtMs);
      const next = parseCorpCodeXml(xml);
      for (const [symbol, oldCorp] of parseCorpCodeXml(previous.xml)) {
        const newCorp = next.get(symbol);
        if (newCorp !== undefined && newCorp !== oldCorp) this.onIdentityChanged?.(symbol, oldCorp, newCorp);
      }
    }
    this.sqlite.prepare(`INSERT INTO dart_corp_code_snapshot (namespace, xml, content_hash, fetched_at_ms)
      VALUES (?, ?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET
      xml = excluded.xml, content_hash = excluded.content_hash, fetched_at_ms = excluded.fetched_at_ms`)
      .run(this.namespace, xml, createHash("sha256").update(xml).digest("hex"), fetchedAtMs);
    })();
  }
}
