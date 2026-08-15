ALTER TABLE `backtest_jobs` ADD `attempt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `lease_token_hash` text;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `lease_expires_at_ms` integer;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `runner_version` text;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `result_schema_version` integer;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `result_checksum` text;