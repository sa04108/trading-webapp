CREATE TABLE `trading_control` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`account_id` text,
	`accounts_json` text DEFAULT '[]' NOT NULL,
	`snapshot_json` text,
	`synced_at_ms` integer,
	`error` text,
	`executor_token` text,
	`executor_expires_at_ms` integer,
	CONSTRAINT "trading_singleton" CHECK("trading_control"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `trading_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`slot` integer,
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
	CONSTRAINT "trading_slot_value" CHECK("trading_deployments"."slot" IS NULL OR "trading_deployments"."slot" = 1),
	CONSTRAINT "trading_deployment_status" CHECK("trading_deployments"."status" IN ('INACTIVE', 'ACTIVE', 'STOPPING', 'ERROR'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trading_registered_slot` ON `trading_deployments` (`slot`);--> statement-breakpoint
CREATE TABLE `trading_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deployment_id` text,
	`actor` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trading_events_time` ON `trading_events` (`created_at_ms`);--> statement-breakpoint
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
CREATE INDEX `trading_orders_deployment` ON `trading_orders` (`deployment_id`,`created_at_ms`);