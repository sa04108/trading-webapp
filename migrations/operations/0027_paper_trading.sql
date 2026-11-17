CREATE TABLE `paper_trading_account` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`cash` real NOT NULL,
	`holdings_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "paper_trading_singleton" CHECK("paper_trading_account"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `paper_trading_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `paper_trading_orders_time` ON `paper_trading_orders` (`created_at_ms`);--> statement-breakpoint
ALTER TABLE `trading_control` ADD `mode` text DEFAULT 'LIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_deployments` ADD `mode` text DEFAULT 'LIVE' NOT NULL;