CREATE TABLE `intraday_validation_trials` (
	`id` text PRIMARY KEY NOT NULL,
	`validation_id` text NOT NULL,
	`fold` integer NOT NULL,
	`role` text NOT NULL,
	`candidate` integer,
	`request_json` text,
	`metrics_json` text,
	`run_id` text,
	`skip_reason` text,
	FOREIGN KEY (`validation_id`) REFERENCES `intraday_validations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `intraday_runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intraday_validation_trials_run_id_unique` ON `intraday_validation_trials` (`run_id`);--> statement-breakpoint
CREATE INDEX `intraday_trial_parent` ON `intraday_validation_trials` (`validation_id`,`fold`);--> statement-breakpoint
CREATE TABLE `intraday_validations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_job_id` text NOT NULL,
	`request_json` text NOT NULL,
	`config_json` text NOT NULL,
	`plan_json` text NOT NULL,
	`execution_version` text NOT NULL,
	`validation_version` text NOT NULL,
	`strategy_version` text NOT NULL,
	`data_revision` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	FOREIGN KEY (`source_job_id`) REFERENCES `intraday_runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `intraday_validation_source` ON `intraday_validations` (`owner_id`,`source_job_id`);