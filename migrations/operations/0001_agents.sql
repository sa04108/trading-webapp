CREATE TABLE `agent_backtest_datasets` (
	`job_id` text PRIMARY KEY NOT NULL,
	`dataset_version` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer,
	`revoked_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_clients_token_hash_unique` ON `agent_clients` (`token_hash`);--> statement-breakpoint
CREATE TABLE `agent_data_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_version` integer,
	`next_attempt_at_ms` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_data_waits` (
	`kind` text NOT NULL,
	`job_id` text NOT NULL,
	`request_id` text NOT NULL,
	`requested_version` integer NOT NULL,
	PRIMARY KEY(`kind`, `job_id`),
	FOREIGN KEY (`request_id`) REFERENCES `agent_data_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_preparation_leases` (
	`job_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_token_hash` text,
	`lease_expires_at_ms` integer,
	`dataset_version` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`result_hash` text,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
