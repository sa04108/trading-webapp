CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`event` text NOT NULL,
	`detail_json` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backtest_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`request_json` text NOT NULL,
	`strategy_id` text NOT NULL,
	`universe_json` text,
	`universe_hash` text,
	`progress_bars` integer,
	`total_bars` integer,
	`progress_label` text,
	`execution_activity` text,
	`activity_started_at_ms` integer,
	`last_progress_at_ms` integer,
	`last_received_at_ms` integer,
	`result_transfer_bytes` integer,
	`result_transfer_total_bytes` integer,
	`error` text,
	"agent_id" text,
	`pid` integer,
	`created_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`completed_at_ms` integer,
	`provenance_pin_json` text,
	`universe_rule_json` text NOT NULL,
	`universe_schedule_json` text NOT NULL,
	`submit_warnings_json` text,
	`benchmark_json` text,
	`benchmark_hash` text,
	`clone_batch_id` text,
	`clone_source_job_id` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_token_hash` text,
	`lease_expires_at_ms` integer,
	`runner_version` text,
	`result_schema_version` integer,
	`result_checksum` text,
	`preparation_job_id` text REFERENCES backtest_preparation_jobs(id) ON DELETE restrict
, `estimated_bars` integer DEFAULT 0 NOT NULL, `lease_failures` integer DEFAULT 0 NOT NULL);
--> statement-breakpoint
CREATE TABLE `backtest_preparation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`done_symbols` integer DEFAULT 0 NOT NULL,
	`total_symbols` integer DEFAULT 0 NOT NULL,
	`saved_facts` integer DEFAULT 0 NOT NULL,
	`gap_count` integer DEFAULT 0 NOT NULL,
	`resolution_pass` integer DEFAULT 0 NOT NULL,
	`dart_quota_date_kst` text,
	`dart_calls_used` integer DEFAULT 0 NOT NULL,
	`next_resume_at_ms` integer,
	`preview_json` text,
	`error` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	`lifecycle_managed` integer DEFAULT false NOT NULL,
	`overall_progress` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE operational_database_state (singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1), dataset_id TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE `preparation_preview_cache` (
	`job_id` text PRIMARY KEY NOT NULL,
	`data_revision` integer NOT NULL,
	`validation_version` text NOT NULL,
	`fundamental_symbols_json` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_time` ON `audit_logs` (`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_jobs_created` ON `backtest_jobs` (`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_jobs_preparation` ON `backtest_jobs` (`preparation_job_id`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_jobs_status` ON `backtest_jobs` (`status`,`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `preparation_jobs_hash_idx` ON `backtest_preparation_jobs` (`request_hash`,`status`);
--> statement-breakpoint
CREATE TRIGGER `preparation_cache_job_update`
AFTER UPDATE OF `preview_json`, `request_json`, `request_hash`, `status` ON `backtest_preparation_jobs`
BEGIN
  DELETE FROM `preparation_preview_cache` WHERE `job_id` = NEW.`id`;
END;
