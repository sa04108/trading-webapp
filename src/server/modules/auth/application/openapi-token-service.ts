import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import { newId } from "../../../../runtime/shared/ids.js";
import { openApiTokens } from "../../../shared/db/openapi-token-schema.js";
import { users } from "../../../shared/db/auth-schema.js";
import { openApiTokenIssueSchema, type OpenApiTokenRecord } from "../../../../shared/schemas/openapi-token.js";
import type { AuditSink, AuthenticatedUser } from "./auth-service.js";

export class OpenApiTokenError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const metadata = { id: openApiTokens.id, name: openApiTokens.name, prefix: openApiTokens.prefix, scope: openApiTokens.scope,
  createdAtMs: openApiTokens.createdAtMs, expiresAtMs: openApiTokens.expiresAtMs, lastUsedAtMs: openApiTokens.lastUsedAtMs, revokedAtMs: openApiTokens.revokedAtMs };

export class OpenApiTokenService {
  constructor(private readonly database: DatabaseHandle, private readonly clock: Clock, private readonly audit: AuditSink) {}
  list(ownerId: string): OpenApiTokenRecord[] {
    return this.database.db.select(metadata).from(openApiTokens).where(and(eq(openApiTokens.ownerId, ownerId), isNull(openApiTokens.revokedAtMs))).orderBy(desc(openApiTokens.createdAtMs), desc(openApiTokens.id)).all();
  }
  issue(user: AuthenticatedUser, raw: unknown): { token: string; record: OpenApiTokenRecord } {
    const body = openApiTokenIssueSchema.parse(raw), now = this.clock.now();
    const token = `qpo_${randomBytes(32).toString("base64url")}`;
    const record: OpenApiTokenRecord = { id: newId("apit"), name: body.name, prefix: token.slice(0, 12), scope: body.scope,
      createdAtMs: now, expiresAtMs: now + body.expiresInDays * 86400000, lastUsedAtMs: null, revokedAtMs: null };
    this.database.sqlite.transaction(() => {
      const active = this.database.db.select({ id: openApiTokens.id }).from(openApiTokens).where(and(eq(openApiTokens.ownerId, user.id), isNull(openApiTokens.revokedAtMs), gt(openApiTokens.expiresAtMs, now))).limit(100).all();
      if (active.length >= 100) throw new OpenApiTokenError("유효한 토큰은 최대 100개입니다. 사용하지 않는 토큰을 폐기하세요.", 409);
      this.database.db.insert(openApiTokens).values({ ...record, ownerId: user.id, tokenHash: hash(token) }).run();
      this.audit.record(user.username, "openapi-token.issued", { tokenId: record.id, scope: record.scope, expiresAtMs: record.expiresAtMs });
    }).immediate();
    return { token, record };
  }
  revoke(user: AuthenticatedUser, id: string): void {
    this.database.sqlite.transaction(() => {
      const row = this.database.db.select({ id: openApiTokens.id, revokedAtMs: openApiTokens.revokedAtMs }).from(openApiTokens).where(and(eq(openApiTokens.id, id), eq(openApiTokens.ownerId, user.id))).get();
      if (!row) throw new OpenApiTokenError("토큰을 찾을 수 없습니다.", 404);
      this.database.db.delete(openApiTokens).where(and(eq(openApiTokens.id, id), eq(openApiTokens.ownerId, user.id))).run();
      if (row.revokedAtMs === null) this.audit.record(user.username, "openapi-token.revoked", { tokenId: id });
    }).immediate();
  }
  authenticate(token: string): { user: AuthenticatedUser; scope: OpenApiTokenRecord["scope"]; tokenId: string } | null {
    if (!/^qpo_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = this.clock.now();
    const row = this.database.db.select({ userId: users.id, username: users.username, tokenId: openApiTokens.id, scope: openApiTokens.scope })
      .from(openApiTokens).innerJoin(users, eq(openApiTokens.ownerId, users.id))
      .where(and(eq(openApiTokens.tokenHash, hash(token)), isNull(openApiTokens.revokedAtMs), gt(openApiTokens.expiresAtMs, now))).get();
    if (!row) return null;
    // 빈번한 조회 때문에 SQLite 쓰기가 매 요청마다 발생하지 않도록 최근 사용 시각은 분 단위로 갱신한다.
    this.database.sqlite.prepare("UPDATE openapi_tokens SET last_used_at_ms=? WHERE id=? AND (last_used_at_ms IS NULL OR last_used_at_ms<=?)").run(now, row.tokenId, now - 60000);
    return { user: { id: row.userId, username: row.username }, scope: row.scope, tokenId: row.tokenId };
  }
}
