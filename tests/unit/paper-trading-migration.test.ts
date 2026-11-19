import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it } from "vitest";
import { migrateDatabaseRole } from "../../src/runtime/shared/db/database-layout.js";

it("preserves existing paper accounts, deployments and linked orders during slot migration", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)");
    for (const migration of readMigrationFiles({ migrationsFolder: "migrations/operations" }).slice(0, 30)) {
      for (const statement of migration.sql) sqlite.exec(statement);
      sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(migration.hash, migration.folderMillis);
    }
    sqlite.exec(`
      INSERT INTO trading_control (singleton, revision, mode, account_id, accounts_json, snapshot_json, synced_at_ms, error, executor_token, executor_expires_at_ms)
        VALUES (1, 42, 'PAPER', 'PAPER', '["PAPER"]', '{"cash":123}', 123, 'old error', 'lease', 456);
      INSERT INTO paper_trading_account (singleton, initial_cash, cash, holdings_json)
        VALUES (1, 500000, 489998.5, '{"005930":{"quantity":10,"cost":10000}}');
      INSERT INTO trading_deployments (id, slot, mode, setup_json, name, version, status, created_at_ms, updated_at_ms, activated_at_ms, last_decision_at_ms, last_error, activity, checkpoint, portfolio_json, realized_pnl, return_base, daily_base_json)
        VALUES ('registered', 1, 'PAPER', '{"strategyId":"alpha"}', 'active', 'v2', 'ACTIVE', 10, 20, 11, 19, 'previous', 'working', 'cp', '{"shares":10}', 12.5, 500000, '{"base":500000}'),
               ('archived', NULL, 'PAPER', '{}', 'old', 'v1', 'INACTIVE', 1, 2, NULL, NULL, NULL, 'done', NULL, '{}', -7, NULL, NULL);
      INSERT INTO trading_orders (id, deployment_id, account_id, broker_order_id, decision_key, payload_json, status, applied_quantity, applied_amount, applied_costs, created_at_ms, updated_at_ms)
        VALUES ('order', 'registered', 'PAPER', 'fill', 'decision', '{"symbol":"005930"}', 'FILLED', 10, 10000, 1.5, 30, 31);
      INSERT INTO paper_trading_orders (id, payload_json, created_at_ms) VALUES ('fill', '{"order":{"filledQuantity":10}}', 30);
    `);
    const control = sqlite.prepare("SELECT * FROM trading_control").all();
    const account = sqlite.prepare("SELECT * FROM paper_trading_account").all();
    const deployments = sqlite.prepare("SELECT * FROM trading_deployments ORDER BY id").all();
    const orders = sqlite.prepare("SELECT * FROM trading_orders").all();
    const fills = sqlite.prepare("SELECT * FROM paper_trading_orders").all();

    migrateDatabaseRole(sqlite, "operations", "main");

    expect(sqlite.prepare("SELECT * FROM trading_control").all()).toEqual(control);
    expect(sqlite.prepare("SELECT * FROM paper_trading_account").all()).toEqual(account);
    expect(sqlite.prepare("SELECT * FROM trading_deployments ORDER BY id").all()).toEqual(deployments.map(row => ({ ...row as object, account_slot: 1 })));
    expect(sqlite.prepare("SELECT * FROM trading_orders").all()).toEqual(orders);
    expect(sqlite.prepare("SELECT * FROM paper_trading_orders").all()).toEqual(fills.map(row => ({ ...row as object, account_slot: 1 })));
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(() => sqlite.prepare("DELETE FROM trading_deployments WHERE id = 'registered'").run()).toThrow();
    expect(() => sqlite.prepare("UPDATE trading_orders SET deployment_id = 'missing' WHERE id = 'order'").run()).toThrow();
    expect(() => sqlite.prepare("INSERT INTO trading_orders SELECT 'duplicate', deployment_id, account_id, broker_order_id, decision_key, payload_json, status, applied_quantity, applied_amount, applied_costs, created_at_ms, updated_at_ms FROM trading_orders WHERE id = 'order'").run()).toThrow();
    expect(() => sqlite.prepare("INSERT INTO trading_orders SELECT 'duplicate-decision', deployment_id, 'other', 'other', decision_key, payload_json, status, applied_quantity, applied_amount, applied_costs, created_at_ms, updated_at_ms FROM trading_orders WHERE id = 'order'").run()).toThrow();
    expect(() => sqlite.prepare("INSERT INTO trading_orders SELECT 'duplicate-broker', deployment_id, account_id, broker_order_id, 'other', payload_json, status, applied_quantity, applied_amount, applied_costs, created_at_ms, updated_at_ms FROM trading_orders WHERE id = 'order'").run()).toThrow();
    sqlite.exec(`
      INSERT INTO trading_control (singleton, revision, mode) VALUES (2, 0, 'PAPER');
      INSERT INTO paper_trading_account (singleton, cash) VALUES (2, 200000);
      INSERT INTO trading_deployments (id, slot, account_slot, mode, setup_json, name, version, status, created_at_ms, updated_at_ms, activity)
        VALUES ('second', 2, 2, 'PAPER', '{}', 'second', '1', 'INACTIVE', 1, 1, '');
      INSERT INTO paper_trading_orders (id, account_slot, payload_json, created_at_ms) VALUES ('second-fill', 2, '{}', 32);
    `);
    expect(sqlite.prepare("SELECT singleton, cash FROM paper_trading_account ORDER BY singleton").all()).toEqual([{ singleton: 1, cash: 489998.5 }, { singleton: 2, cash: 200000 }]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  } finally { sqlite.close(); }
});
