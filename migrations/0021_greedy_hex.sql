CREATE TABLE `backtest_clone_batch_items` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`random_seed` integer NOT NULL,
	`state` text NOT NULL,
	`job_id` text,
	FOREIGN KEY (`batch_id`) REFERENCES `backtest_clone_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_backtest_clone_batch_item_ordinal` ON `backtest_clone_batch_items` (`batch_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_backtest_clone_batch_item_seed` ON `backtest_clone_batch_items` (`batch_id`,`random_seed`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_backtest_clone_batch_item_job` ON `backtest_clone_batch_items` (`job_id`);--> statement-breakpoint
CREATE INDEX `idx_backtest_clone_batch_items_pending` ON `backtest_clone_batch_items` (`batch_id`,`state`);--> statement-breakpoint
CREATE TABLE `backtest_clone_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`source_job_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`status` text NOT NULL,
	`total_count` integer NOT NULL,
	`request_json` text NOT NULL,
	`universe_schedule_json` text NOT NULL,
	`provenance_pin_json` text,
	`universe_json` text,
	`universe_hash` text,
	`benchmark_json` text,
	`benchmark_hash` text,
	`submit_warnings_json` text,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`completed_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_clone_batches_created` ON `backtest_clone_batches` (`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_backtest_clone_batches_status` ON `backtest_clone_batches` (`status`,`created_at_ms`);--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `clone_batch_id` text;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `clone_source_job_id` text;