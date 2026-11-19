import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 계좌별 개정 번호와 임대로 여러 탭·프로세스의 주문 허용 상태를 동기화한다. */
export const tradingControl = sqliteTable("trading_control", {
  singleton: integer("singleton").primaryKey(),
  revision: integer("revision").notNull().default(0),
  mode: text("mode", { enum: ["LIVE", "PAPER"] }).notNull().default("LIVE"),
  accountId: text("account_id"),
  accountsJson: text("accounts_json").notNull().default("[]"),
  snapshotJson: text("snapshot_json"),
  syncedAtMs: integer("synced_at_ms"),
  error: text("error"),
  executorToken: text("executor_token"),
  executorExpiresAtMs: integer("executor_expires_at_ms"),
}, table => [check("trading_account_slot", sql`${table.singleton} >= 1`)]);

export const tradingDeployments = sqliteTable("trading_deployments", {
  id: text("id").primaryKey(),
  slot: integer("slot"),
  accountSlot: integer("account_slot").notNull().default(1),
  mode: text("mode", { enum: ["LIVE", "PAPER"] }).notNull().default("LIVE"),
  setupJson: text("setup_json").notNull(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  status: text("status", { enum: ["INACTIVE", "ACTIVE", "STOPPING", "ERROR"] }).notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  activatedAtMs: integer("activated_at_ms"),
  lastDecisionAtMs: integer("last_decision_at_ms"),
  lastError: text("last_error"),
  activity: text("activity").notNull(),
  checkpoint: text("checkpoint"),
  portfolioJson: text("portfolio_json").notNull().default("{}"),
  realizedPnl: real("realized_pnl").notNull().default(0),
  returnBase: real("return_base"),
  dailyBaseJson: text("daily_base_json"),
}, table => [
  uniqueIndex("trading_registered_slot").on(table.slot),
  check("trading_slot_value", sql`${table.accountSlot} >= 1 AND (${table.slot} IS NULL OR ${table.slot} = ${table.accountSlot})`),
  check("trading_deployment_status", sql`${table.status} IN ('INACTIVE', 'ACTIVE', 'STOPPING', 'ERROR')`),
]);

/** 사용자가 요청한 자동매매 전환은 계좌별로 한 건씩 처리한다. */
export const tradingToggleJobs = sqliteTable("trading_toggle_jobs", {
  id: text("id").primaryKey(),
  accountSlot: integer("account_slot").notNull(),
  deploymentId: text("deployment_id").notNull(),
  ownerId: text("owner_id").notNull(),
  action: text("action", { enum: ["activate", "deactivate"] }).notNull(),
  title: text("title").notNull(),
  status: text("status", { enum: ["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"] }).notNull(),
  message: text("message").notNull(),
  executorToken: text("executor_token").notNull(),
  expectedRevision: integer("expected_revision").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  finishedAtMs: integer("finished_at_ms"),
}, table => [
  uniqueIndex("trading_toggle_active_slot").on(table.accountSlot).where(sql`${table.finishedAtMs} IS NULL`),
  index("trading_toggle_deployment_created").on(table.deploymentId, table.createdAtMs),
  index("trading_toggle_finished").on(table.finishedAtMs),
]);

export const tradingOrders = sqliteTable("trading_orders", {
  id: text("id").primaryKey(),
  deploymentId: text("deployment_id").notNull().references(() => tradingDeployments.id, { onDelete:"restrict" }),
  accountId: text("account_id").notNull(),
  brokerOrderId: text("broker_order_id"),
  decisionKey: text("decision_key").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull(),
  appliedQuantity: integer("applied_quantity").notNull().default(0),
  appliedAmount: real("applied_amount").notNull().default(0),
  appliedCosts: real("applied_costs").notNull().default(0),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
}, table => [
  uniqueIndex("trading_decision_order").on(table.deploymentId, table.decisionKey),
  uniqueIndex("trading_broker_order").on(table.accountId, table.brokerOrderId),
  index("trading_orders_deployment").on(table.deploymentId, table.createdAtMs),
]);

export const tradingEvents = sqliteTable("trading_events", {
  accountSlot: integer("account_slot").notNull().default(1),
  id: integer("id").primaryKey({autoIncrement:true}),
  deploymentId: text("deployment_id"),
  actor: text("actor").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
}, table => [index("trading_events_time").on(table.createdAtMs)]);

/** 모의 잔고는 전략을 제거하거나 서버를 다시 시작해도 유지한다. */
export const paperTradingAccount = sqliteTable("paper_trading_account", {
  singleton: integer("singleton").primaryKey(),
  initialCash: real("initial_cash").notNull().default(100_000_000),
  cash: real("cash").notNull(),
  holdingsJson: text("holdings_json").notNull().default("{}"),
}, table => [check("paper_trading_account_slot", sql`${table.singleton} >= 1`)]);

/** 주문 ID의 유일성과 잔고 갱신을 같은 트랜잭션으로 묶어 중복 체결을 막는다. */
export const paperTradingOrders = sqliteTable("paper_trading_orders", {
  id: text("id").primaryKey(),
  accountSlot: integer("account_slot").notNull().default(1),
  payloadJson: text("payload_json").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
}, table => [index("paper_trading_orders_account_time").on(table.accountSlot, table.createdAtMs)]);
