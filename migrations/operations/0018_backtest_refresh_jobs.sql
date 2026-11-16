CREATE TABLE `backtest_refresh_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`source_job_id` text NOT NULL,
	`action_json` text NOT NULL,
	`request_json` text NOT NULL,
	`warnings_json` text NOT NULL,
	`runtime_identity` text NOT NULL,
	`status` text NOT NULL,
	`preparation_job_id` text,
	`result_href` text,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	`notified_at_ms` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preparation_job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_backtest_refresh_request` ON `backtest_refresh_jobs` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_backtest_refresh_active` ON `backtest_refresh_jobs` (`status`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_backtest_refresh_preparation` ON `backtest_refresh_jobs` (`preparation_job_id`);