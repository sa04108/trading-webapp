import type Database from "better-sqlite3";
import type { StockInfo } from "../../../../runtime/modules/market-data/application/ports.js";
import type { SymbolDirectoryEntry, SymbolLibrary } from "../../../../shared/schemas/symbol-library.js";
import type { LocalSymbolNameSource } from "./symbol-info-service.js";

const validCode = (code: string) => /^\d{6}$/.test(code);

export class SymbolLibraryService implements LocalSymbolNameSource {
  constructor(private readonly sqlite: Database.Database, private readonly now: () => number = Date.now) {}

  /** 기존 종목 마스터를 검색 사전에 반영한다. 토스로 확인한 이름을 오래된 로컬 값으로 덮지 않는다. */
  private seed(): void {
    this.sqlite.prepare(`INSERT INTO symbol_directory (symbol, name, market, source, updated_at_ms)
      SELECT short_code, name, market, 'local', recorded_at_ms FROM data.symbol_master_versions
      WHERE valid_to_date IS NULL AND length(short_code) = 6 AND short_code NOT GLOB '*[^0-9]*'
      ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, market = excluded.market, updated_at_ms = excluded.updated_at_ms
      WHERE symbol_directory.source = 'local' AND excluded.updated_at_ms > symbol_directory.updated_at_ms`).run();
    this.sqlite.prepare(`INSERT OR IGNORE INTO symbol_directory (symbol, name, market, source, updated_at_ms)
      SELECT code, name, market, 'local', created_at_ms FROM data.symbols
      WHERE name IS NOT NULL AND trim(name) != '' AND name != code AND length(code) = 6 AND code NOT GLOB '*[^0-9]*'`).run();
  }

  rememberNames(stocks: readonly StockInfo[]): void {
    const upsert = this.sqlite.prepare(`INSERT INTO symbol_directory (symbol, name, market, source, updated_at_ms)
      VALUES (?, ?, ?, 'toss', ?) ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, market = excluded.market,
      source = excluded.source, updated_at_ms = excluded.updated_at_ms`);
    this.sqlite.transaction(() => {
      for (const stock of stocks) {
        if (validCode(stock.symbol) && stock.name.trim() && stock.name !== stock.symbol)
          upsert.run(stock.symbol, stock.name, stock.market, this.now());
      }
    })();
  }

  getLocalNames(codes: readonly string[]): ReadonlyMap<string, { name: string; market: string }> {
    this.seed();
    const find = this.sqlite.prepare("SELECT name, market FROM symbol_directory WHERE symbol = ?");
    const result = new Map<string, { name: string; market: string }>();
    for (const code of codes) {
      const row = find.get(code) as { name: string; market: string } | undefined;
      if (row) result.set(code, row);
    }
    return result;
  }

  async search(query: string, lookup: (codes: string[]) => Promise<StockInfo[]>): Promise<SymbolDirectoryEntry[]> {
    this.seed();
    if (validCode(query) && !this.sqlite.prepare("SELECT 1 FROM symbol_directory WHERE symbol = ? AND trim(name) != '' AND name != symbol").get(query)) {
      this.rememberNames(await lookup([query]));
    }
    const escaped = query.replace(/\s/g, "").replace(/[\\%_]/g, "\\$&");
    const matches = this.sqlite.prepare(`SELECT symbol, name, market FROM symbol_directory
      WHERE replace(name, ' ', '') LIKE ? ESCAPE '\\' OR symbol LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN symbol = ? OR name = ? THEN 0 ELSE 1 END, name, symbol LIMIT 20`)
      .all(`%${escaped}%`, `${escaped}%`, query, query) as SymbolDirectoryEntry[];
    // 연결이 없어도 이미 저장된 시세는 코드로 선택한다. 미확인 이름은 사전에 저장하지 않는다.
    return matches.length === 0 && validCode(query) ? [{ symbol: query, name: query, market: "" }] : matches;
  }

  list(ownerId: string): SymbolLibrary {
    this.seed();
    const rows = (column: "favorite_at_ms" | "viewed_at_ms") => this.sqlite.prepare(`
      SELECT l.symbol, COALESCE(d.name, l.symbol) AS name, COALESCE(d.market, '') AS market
      FROM symbol_library l LEFT JOIN symbol_directory d ON d.symbol = l.symbol
      WHERE l.owner_id = ? AND l.${column} IS NOT NULL ORDER BY l.${column} DESC, l.symbol LIMIT 100`)
      .all(ownerId) as SymbolDirectoryEntry[];
    return { favorites: rows("favorite_at_ms"), recent: rows("viewed_at_ms").slice(0, 30) };
  }

  update(ownerId: string, symbol: string, change: { favorite?: boolean; viewed?: true }): SymbolLibrary {
    this.sqlite.transaction(() => {
      if (change.favorite === true) {
        const count = this.sqlite.prepare("SELECT count(*) AS n FROM symbol_library WHERE owner_id = ? AND favorite_at_ms IS NOT NULL AND symbol != ?")
          .get(ownerId, symbol) as { n: number };
        if (count.n >= 100) throw new Error("관심 종목은 최대 100개까지 등록할 수 있습니다.");
      }
      this.sqlite.prepare("INSERT OR IGNORE INTO symbol_library (owner_id, symbol) VALUES (?, ?)").run(ownerId, symbol);
      if (change.favorite !== undefined) this.sqlite.prepare("UPDATE symbol_library SET favorite_at_ms = ? WHERE owner_id = ? AND symbol = ?")
        .run(change.favorite ? this.now() : null, ownerId, symbol);
      if (change.viewed) {
        // 같은 밀리초에 연속 조회해도 최신 조회 순서를 유지한다.
        this.sqlite.prepare(`UPDATE symbol_library SET viewed_at_ms = max(?, COALESCE((SELECT max(viewed_at_ms) + 1 FROM symbol_library WHERE owner_id = ?), 0))
          WHERE owner_id = ? AND symbol = ?`).run(this.now(), ownerId, ownerId, symbol);
        this.sqlite.prepare(`UPDATE symbol_library SET viewed_at_ms = NULL WHERE owner_id = ? AND symbol NOT IN (
          SELECT symbol FROM symbol_library WHERE owner_id = ? AND viewed_at_ms IS NOT NULL ORDER BY viewed_at_ms DESC, symbol LIMIT 30
        )`).run(ownerId, ownerId);
      }
      this.sqlite.prepare("DELETE FROM symbol_library WHERE owner_id = ? AND favorite_at_ms IS NULL AND viewed_at_ms IS NULL").run(ownerId);
    })();
    return this.list(ownerId);
  }
}
