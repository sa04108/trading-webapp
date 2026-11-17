CREATE TABLE `configuration_search_items` (
	`id` text PRIMARY KEY NOT NULL,
	`search_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`request_json` text NOT NULL,
	`values_json` text NOT NULL,
	`status` text NOT NULL,
	`preparation_job_id` text,
	`job_id` text,
	`error` text,
	FOREIGN KEY (`search_id`) REFERENCES `configuration_searches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preparation_job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_configuration_search_ordinal` ON `configuration_search_items` (`search_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_configuration_search_job` ON `configuration_search_items` (`job_id`);--> statement-breakpoint
CREATE INDEX `idx_configuration_search_preparation` ON `configuration_search_items` (`preparation_job_id`);--> statement-breakpoint
CREATE TABLE `configuration_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`mode` text NOT NULL,
	`source_job_id` text NOT NULL,
	`config_json` text NOT NULL,
	`catalog_json` text NOT NULL,
	`runtime_identity` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	`notified_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_configuration_search_request` ON `configuration_searches` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_configuration_search_source` ON `configuration_searches` (`mode`,`source_job_id`);--> statement-breakpoint
CREATE INDEX `idx_configuration_search_status` ON `configuration_searches` (`status`);