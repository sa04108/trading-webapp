CREATE TABLE `__new_paper_trading_account` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`initial_cash` real DEFAULT 100000000 NOT NULL,
	`cash` real NOT NULL,
	`holdings_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "paper_trading_account_slot" CHECK("__new_paper_trading_account"."singleton" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_paper_trading_account`("singleton", "initial_cash", "cash", "holdings_json") SELECT "singleton", "initial_cash", "cash", "holdings_json" FROM `paper_trading_account`;--> statement-breakpoint
DROP TABLE `paper_trading_account`;--> statement-breakpoint
ALTER TABLE `__new_paper_trading_account` RENAME TO `paper_trading_account`;--> statement-breakpoint
CREATE TABLE `__new_trading_control` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`mode` text DEFAULT 'LIVE' NOT NULL,
	`account_id` text,
	`accounts_json` text DEFAULT '[]' NOT NULL,
	`snapshot_json` text,
	`synced_at_ms` integer,
	`error` text,
	`executor_token` text,
	`executor_expires_at_ms` integer,
	CONSTRAINT "trading_account_slot" CHECK("__new_trading_control"."singleton" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_trading_control`("singleton", "revision", "mode", "account_id", "accounts_json", "snapshot_json", "synced_at_ms", "error", "executor_token", "executor_expires_at_ms") SELECT "singleton", "revision", "mode", "account_id", "accounts_json", "snapshot_json", "synced_at_ms", "error", "executor_token", "executor_expires_at_ms" FROM `trading_control`;--> statement-breakpoint
DROP TABLE `trading_control`;--> statement-breakpoint
ALTER TABLE `__new_trading_control` RENAME TO `trading_control`;--> statement-breakpoint
CREATE TABLE `__new_trading_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`slot` integer,
	`account_slot` integer DEFAULT 1 NOT NULL,
	`mode` text DEFAULT 'LIVE' NOT NULL,
	`setup_json` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`status` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`activated_at_ms` integer,
	`last_decision_at_ms` integer,
	`last_error` text,
	`activity` text NOT NULL,
	`checkpoint` text,
	`portfolio_json` text DEFAULT '{}' NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`return_base` real,
	`daily_base_json` text,
	CONSTRAINT "trading_slot_value" CHECK("__new_trading_deployments"."account_slot" >= 1 AND ("__new_trading_deployments"."slot" IS NULL OR "__new_trading_deployments"."slot" = "__new_trading_deployments"."account_slot")),
	CONSTRAINT "trading_deployment_status" CHECK("__new_trading_deployments"."status" IN ('INACTIVE', 'ACTIVE', 'STOPPING', 'ERROR'))
);
--> statement-breakpoint
INSERT INTO `__new_trading_deployments`("id", "slot", "account_slot", "mode", "setup_json", "name", "version", "status", "created_at_ms", "updated_at_ms", "activated_at_ms", "last_decision_at_ms", "last_error", "activity", "checkpoint", "portfolio_json", "realized_pnl", "return_base", "daily_base_json") SELECT "id", "slot", 1, "mode", "setup_json", "name", "version", "status", "created_at_ms", "updated_at_ms", "activated_at_ms", "last_decision_at_ms", "last_error", "activity", "checkpoint", "portfolio_json", "realized_pnl", "return_base", "daily_base_json" FROM `trading_deployments`;--> statement-breakpoint
-- 배포 테이블을 교체하는 동안 주문과 외래 키를 같은 트랜잭션에서 보존한다.
CREATE TABLE `__saved_trading_orders` AS SELECT * FROM `trading_orders`;--> statement-breakpoint
DROP TABLE `trading_orders`;--> statement-breakpoint
DROP TABLE `trading_deployments`;--> statement-breakpoint
ALTER TABLE `__new_trading_deployments` RENAME TO `trading_deployments`;--> statement-breakpoint
CREATE UNIQUE INDEX `trading_registered_slot` ON `trading_deployments` (`slot`);--> statement-breakpoint
CREATE TABLE `trading_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`account_id` text NOT NULL,
	`broker_order_id` text,
	`decision_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`applied_quantity` integer DEFAULT 0 NOT NULL,
	`applied_amount` real DEFAULT 0 NOT NULL,
	`applied_costs` real DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `trading_deployments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trading_decision_order` ON `trading_orders` (`deployment_id`,`decision_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `trading_broker_order` ON `trading_orders` (`account_id`,`broker_order_id`);--> statement-breakpoint
CREATE INDEX `trading_orders_deployment` ON `trading_orders` (`deployment_id`,`created_at_ms`);--> statement-breakpoint
INSERT INTO `trading_orders` SELECT * FROM `__saved_trading_orders`;--> statement-breakpoint
DROP TABLE `__saved_trading_orders`;--> statement-breakpoint
DROP INDEX `paper_trading_orders_time`;--> statement-breakpoint
ALTER TABLE `paper_trading_orders` ADD `account_slot` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `paper_trading_orders_account_time` ON `paper_trading_orders` (`account_slot`,`created_at_ms`);--> statement-breakpoint
ALTER TABLE `trading_events` ADD `account_slot` integer DEFAULT 1 NOT NULL;
