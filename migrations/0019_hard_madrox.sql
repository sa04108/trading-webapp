CREATE TABLE `benchmark_daily_values` (
	`benchmark_id` text NOT NULL,
	`date` text NOT NULL,
	`close` real NOT NULL,
	`synced_at_ms` integer NOT NULL,
	PRIMARY KEY(`benchmark_id`, `date`)
);
--> statement-breakpoint
CREATE INDEX `idx_benchmark_daily_values_date` ON `benchmark_daily_values` (`date`);--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `benchmark_json` text;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `benchmark_hash` text;