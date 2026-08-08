CREATE TABLE `krx_non_trading_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `krx_non_trading_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`short_code` text NOT NULL,
	`market` text NOT NULL,
	`last_close` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kntd_date_code` ON `krx_non_trading_days` (`date`,`short_code`);--> statement-breakpoint
CREATE INDEX `idx_kntd_date` ON `krx_non_trading_days` (`date`);