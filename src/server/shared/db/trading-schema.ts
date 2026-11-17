import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 단일 슬롯과 개정 번호는 여러 탭·프로세스에서도 동일한 주문 허용 상태를 본다. */
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
}, table => [check("trading_singleton", sql`${table.singleton} = 1`)]);

export const tradingDeployments = sqliteTable("trading_deployments", {
  id: text("id").primaryKey(),
  slot: integer("slot"),
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
  check("trading_slot_value", sql`${table.slot} IS NULL OR ${table.slot} = 1`),
  check("trading_deployment_status", sql`${table.status} IN ('INACTIVE', 'ACTIVE', 'STOPPING', 'ERROR')`),
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
  cash: real("cash").notNull(),
  holdingsJson: text("holdings_json").notNull().default("{}"),
}, table => [check("paper_trading_singleton", sql`${table.singleton} = 1`)]);

/** 주문 ID의 유일성과 잔고 갱신을 같은 트랜잭션으로 묶어 중복 체결을 막는다. */
export const paperTradingOrders = sqliteTable("paper_trading_orders", {
  id: text("id").primaryKey(),
  payloadJson: text("payload_json").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
}, table => [index("paper_trading_orders_time").on(table.createdAtMs)]);
