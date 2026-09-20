import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it } from "vitest";
import { migrateDatabaseRole } from "../../src/runtime/shared/db/database-layout.js";

it("기존 승인 대기만 자동 재개하고 완료 이력·무결성 차단·소진 한도를 보존한다", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)");
    for (const migration of readMigrationFiles({ migrationsFolder: "migrations/operations" }).slice(0, 9)) {
      for (const statement of migration.sql) sqlite.exec(statement);
      sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(migration.hash, migration.folderMillis);
    }
    const insertPlan = sqlite.prepare(`INSERT INTO provider_request_plans
      (fingerprint, request_json, reason, evidence, status, attempts, max_attempts, created_at_ms)
      VALUES (?, '{}', 'SOURCE_RECOVERY', '원문 손상', ?, ?, 5, 1)`);
    insertPlan.run("blocked", "BLOCKED", 0);
    insertPlan.run("cancelled", "CANCELLED", 1);
    insertPlan.run("exhausted", "APPROVED", 5);
    insertPlan.run("completed", "COMPLETED", 1);
    const insertRequest = sqlite.prepare(`INSERT INTO agent_data_requests
      (id, request_json, status, created_at_ms, updated_at_ms, error)
      VALUES (?, '{}', 'BLOCKED', 1, 1, ?)`);
    insertRequest.run("recover", "SOURCE_RECOVERY: blocked (원문 손상)");
    insertRequest.run("exhausted", "SOURCE_RECOVERY: exhausted (원문 손상)");
    insertRequest.run("identity", "IDENTITY_MISMATCH: blocked (종목 불일치)");
    insertRequest.run("unresolved", "UNRESOLVED_FILING: 보고서 미확정");
    const before = Date.now();
    migrateDatabaseRole(sqlite, "operations", "main");
    const plans = sqlite.prepare("SELECT fingerprint, status, attempts, max_attempts, retry_after_ms FROM provider_request_plans ORDER BY rowid").all();
    expect(plans).toEqual([
      { fingerprint: "blocked", status: "READY", attempts: 0, max_attempts: 5, retry_after_ms: null },
      { fingerprint: "cancelled", status: "READY", attempts: 1, max_attempts: 5, retry_after_ms: null },
      { fingerprint: "exhausted", status: "WAITING_RETRY", attempts: 5, max_attempts: 5, retry_after_ms: expect.any(Number) },
      { fingerprint: "completed", status: "COMPLETED", attempts: 1, max_attempts: 5, retry_after_ms: null },
    ]);
    expect(sqlite.prepare("SELECT id, status FROM agent_data_requests ORDER BY rowid").all()).toEqual([
      { id: "recover", status: "QUEUED" }, { id: "exhausted", status: "QUEUED" },
      { id: "identity", status: "BLOCKED" }, { id: "unresolved", status: "BLOCKED" },
    ]);
    const deadline = (plans[2] as { retry_after_ms: number }).retry_after_ms;
    expect(deadline).toBeGreaterThanOrEqual(before - 1000 + 900_000);
    migrateDatabaseRole(sqlite, "operations", "main");
    expect(sqlite.prepare("SELECT fingerprint, status, attempts, max_attempts, retry_after_ms FROM provider_request_plans ORDER BY rowid").all()).toEqual(plans);
  } finally { sqlite.close(); }
});
