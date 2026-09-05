CREATE TABLE `preparation_wizard_references` (
	`user_id` text PRIMARY KEY NOT NULL,
	`context` text NOT NULL,
	`preparation_job_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preparation_job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_preparation_wizard_job` ON `preparation_wizard_references` (`preparation_job_id`);--> statement-breakpoint
ALTER TABLE `backtest_clone_batches` ADD `preparation_job_id` text REFERENCES backtest_preparation_jobs(id) ON DELETE restrict;--> statement-breakpoint
CREATE INDEX `idx_backtest_clone_batches_preparation` ON `backtest_clone_batches` (`preparation_job_id`);--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `preparation_job_id` text REFERENCES backtest_preparation_jobs(id) ON DELETE restrict;--> statement-breakpoint
CREATE INDEX `idx_backtest_jobs_preparation` ON `backtest_jobs` (`preparation_job_id`);--> statement-breakpoint
ALTER TABLE `backtest_preparation_jobs` ADD `lifecycle_managed` integer DEFAULT false NOT NULL;