import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth-schema.js";
import type { OpenApiTokenScope } from "../../../shared/schemas/openapi-token.js";

/** 토큰 원문은 발급 응답에만 포함하며 서버에는 해시와 식별용 접두사만 보관한다. */
export const openApiTokens = sqliteTable("openapi_tokens", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  scope: text("scope").$type<OpenApiTokenScope>().notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
  lastUsedAtMs: integer("last_used_at_ms"),
  revokedAtMs: integer("revoked_at_ms"),
}, table => [index("idx_openapi_tokens_owner").on(table.ownerId, table.createdAtMs)]);
