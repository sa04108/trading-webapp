import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth-schema.js";

/** 표시·검색 전용 사전이다. 계산용 종목 마스터와 버전은 변경하지 않는다. */
export const symbolDirectory = sqliteTable("symbol_directory", {
  symbol: text("symbol").primaryKey(),
  name: text("name").notNull(),
  market: text("market").notNull(),
  source: text("source").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const symbolLibrary = sqliteTable("symbol_library", {
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull(),
  favoriteAtMs: integer("favorite_at_ms"),
  viewedAtMs: integer("viewed_at_ms"),
}, (t) => [primaryKey({ columns: [t.ownerId, t.symbol] }), index("symbol_library_recent").on(t.ownerId, t.viewedAtMs)]);
