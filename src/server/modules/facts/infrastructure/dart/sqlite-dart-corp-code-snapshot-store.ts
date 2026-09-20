import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { parseCorpCodeXml, type DartCorpCodeSnapshotStore } from "./dart-corp-code-cache.js";
import { DartRawSnapshotError } from "./dart-raw-snapshot-store.js";

type CorpCodeRow = { xml: string; content_hash: string; fetched_at_ms: number };
type CorpCodeHistory = { xml: string; contentHash: string; fetchedAtMs: number };

/** 고유번호 원문을 운영 DB에 저장하고 재시작 후에도 동일 정체성을 재사용한다. */
export class SqliteDartCorpCodeSnapshotStore implements DartCorpCodeSnapshotStore {
  constructor(private readonly sqlite: Database.Database, private readonly namespace: string, private readonly onIdentityChanged?: (symbol: string, previousCorp: string, nextCorp: string) => void) {}

  get(): { xml: string; fetchedAtMs: number; changedSymbols: readonly string[] } | null {
    let row = this.current();
    if (row === undefined) return null;
    const expectedHash = hash(row.xml);
    if (expectedHash !== row.content_hash) {
      const recovered = this.sameHashHistory(row.content_hash);
      if (recovered === null) throw new DartRawSnapshotError("HASH_MISMATCH", "corpCode.xml");
      row = { xml: recovered.xml, content_hash: row.content_hash, fetched_at_ms: recovered.fetchedAtMs };
    }
    const map = parseCorpCodeXml(row.xml);
    const changed = new Set<string>();
    for (const prior of this.validHistory()) {
      for (const [symbol, previous] of parseCorpCodeXml(prior.xml))
        if (map.has(symbol) && map.get(symbol) !== previous) changed.add(symbol);
    }
    return { xml: row.xml, fetchedAtMs: row.fetched_at_ms, changedSymbols: [...changed] };
  }

  put(xml: string, fetchedAtMs: number): void {
    const next = parseCorpCodeXml(xml);
    this.sqlite.transaction(() => {
      // 정체성 이력이 훼손됐으면 새 원문으로 덮어 복구된 것처럼 보이지 않게 한다.
      this.validHistory();
      const previous = this.current();
      const prior = previous === undefined ? this.latestValidHistory() : this.archiveCurrent(previous, fetchedAtMs);
      if (prior !== null) {
        for (const [symbol, oldCorp] of parseCorpCodeXml(prior.xml)) {
          const newCorp = next.get(symbol);
          if (newCorp !== undefined && newCorp !== oldCorp) this.onIdentityChanged?.(symbol, oldCorp, newCorp);
        }
      }
      this.sqlite.prepare(`INSERT INTO dart_corp_code_snapshot (namespace, xml, content_hash, fetched_at_ms)
        VALUES (?, ?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET
        xml = excluded.xml, content_hash = excluded.content_hash, fetched_at_ms = excluded.fetched_at_ms`)
        .run(this.namespace, xml, hash(xml), fetchedAtMs);
    })();
  }

  private current(): CorpCodeRow | undefined {
    return this.sqlite.prepare("SELECT xml, content_hash, fetched_at_ms FROM dart_corp_code_snapshot WHERE namespace = ?")
      .get(this.namespace) as CorpCodeRow | undefined;
  }

  private archiveCurrent(row: CorpCodeRow, archivedAtMs: number): CorpCodeHistory | null {
    const valid = hash(row.xml) === row.content_hash;
    const entry = valid
      ? { kind: "CORP_CODE", namespace: this.namespace, xml: row.xml, contentHash: row.content_hash, fetchedAtMs: row.fetched_at_ms }
      : { kind: "CORP_CODE_CORRUPT", namespace: this.namespace, xml: row.xml, contentHash: row.content_hash,
        actualContentHash: hash(row.xml), fetchedAtMs: row.fetched_at_ms };
    this.sqlite.prepare("INSERT INTO dart_raw_api_snapshot_history (snapshot_json, archived_at_ms) VALUES (?, ?)")
      .run(JSON.stringify(entry), archivedAtMs);
    return valid ? { xml: row.xml, contentHash: row.content_hash, fetchedAtMs: row.fetched_at_ms } : this.latestValidHistory();
  }

  private historyRows(): { snapshot_json: string }[] {
    return this.sqlite.prepare(`SELECT snapshot_json FROM dart_raw_api_snapshot_history
      WHERE json_extract(snapshot_json, '$.kind') = 'CORP_CODE'
      AND json_extract(snapshot_json, '$.namespace') = ? ORDER BY id DESC`).all(this.namespace) as {snapshot_json: string}[];
  }

  private validHistory(): CorpCodeHistory[] {
    const history: CorpCodeHistory[] = [];
    for (const entry of this.historyRows()) {
      let prior: CorpCodeHistory;
      try { prior = JSON.parse(entry.snapshot_json) as CorpCodeHistory; }
      catch { throw new DartRawSnapshotError("HASH_MISMATCH", "corpCode.xml history"); }
      if (hash(prior.xml) !== prior.contentHash)
        throw new DartRawSnapshotError("HASH_MISMATCH", "corpCode.xml history");
      parseCorpCodeXml(prior.xml);
      history.push(prior);
    }
    return history;
  }

  private latestValidHistory(): CorpCodeHistory | null {
    return this.validHistory()[0] ?? null;
  }

  private sameHashHistory(contentHash: string): CorpCodeHistory | null {
    for (const prior of this.validHistory())
      if (prior.contentHash === contentHash) return prior;
    return null;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
