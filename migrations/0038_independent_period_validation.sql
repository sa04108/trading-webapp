CREATE TABLE `backtest_validation_trials` (
	`id` text PRIMARY KEY NOT NULL,
	`validation_id` text NOT NULL,
	`fold` integer NOT NULL,
	`role` text NOT NULL,
	`candidate` integer,
	`request_json` text,
	`preparation_job_id` text,
	`job_id` text,
	FOREIGN KEY (`validation_id`) REFERENCES `backtest_validations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preparation_job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backtest_validation_trials_job_id_unique` ON `backtest_validation_trials` (`job_id`);--> statement-breakpoint
CREATE INDEX `idx_validation_trial_parent` ON `backtest_validation_trials` (`validation_id`,`fold`);--> statement-breakpoint
CREATE INDEX `idx_validation_trial_preparation` ON `backtest_validation_trials` (`preparation_job_id`);--> statement-breakpoint
CREATE TABLE `backtest_validations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_job_id` text NOT NULL,
	`request_json` text NOT NULL,
	`config_json` text NOT NULL,
	`plan_json` text NOT NULL,
	`strategy_version` text NOT NULL,
	`strategy_source_hash` text NOT NULL,
	`engine_version` text NOT NULL,
	`git_commit_sha` text NOT NULL,
	`status` text NOT NULL,
	`fold` integer DEFAULT 0 NOT NULL,
	`phase` text DEFAULT 'PREPARING_TRAIN' NOT NULL,
	`data_revision` integer,
	`error` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_validation_source` ON `backtest_validations` (`source_job_id`);