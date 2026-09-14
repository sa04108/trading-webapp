-- 서버 인증·작업·결과 전용 스키마
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`event` text NOT NULL,
	`detail_json` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
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
	`completed_at_ms` integer,
	`preparation_job_id` text REFERENCES backtest_preparation_jobs(id) ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `backtest_drawdown_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`ts_ms` integer NOT NULL,
	`drawdown` real NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `backtest_equity_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`ts_ms` integer NOT NULL,
	`equity` real NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
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
	`error` text,
	`worker_id` text,
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
);
--> statement-breakpoint
CREATE TABLE `backtest_metrics` (
	`job_id` text PRIMARY KEY NOT NULL,
	`total_return_pct` real NOT NULL,
	`cagr_pct` real,
	`max_drawdown_pct` real NOT NULL,
	`sharpe` real,
	`win_rate` real,
	`trade_count` integer NOT NULL,
	`metrics_json` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `backtest_monthly_returns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`return_pct` real NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
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
CREATE TABLE `backtest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`strategy_version` text NOT NULL,
	`strategy_source_hash` text NOT NULL,
	`parameter_json` text NOT NULL,
	`universe_hash` text NOT NULL,
	`universe_json` text NOT NULL,
	`engine_version` text NOT NULL,
	`fee_model_version` text NOT NULL,
	`slippage_model_version` text NOT NULL,
	`random_seed` integer NOT NULL,
	`git_commit_sha` text NOT NULL,
	`warnings_json` text,
	`open_positions_json` text,
	`started_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	`provenance_pin_json` text,
	`universe_rule_json` text NOT NULL,
	`schedule_hash` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `backtest_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`symbol` text NOT NULL,
	`quantity` real NOT NULL,
	`entry_ts_ms` integer NOT NULL,
	`exit_ts_ms` integer NOT NULL,
	`entry_price` real NOT NULL,
	`exit_price` real NOT NULL,
	`gross_pnl` real NOT NULL,
	`costs` real NOT NULL,
	`net_pnl` real NOT NULL,
	`return_pct` real NOT NULL,
	`holding_time_ms` integer NOT NULL,
	`exit_reason` text,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `backtest_wizard_drafts` (
	`user_id` text NOT NULL,
	`context` text NOT NULL,
	`step` text NOT NULL,
	`payload_json` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`user_id`, `context`, `step`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_backtest_wizard_drafts_step" CHECK("backtest_wizard_drafts"."step" IN ('strategy', 'period', 'universe', 'capital'))
);
--> statement-breakpoint
CREATE TABLE `data_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`source_type` text NOT NULL,
	`symbols_json` text NOT NULL,
	`slice` text DEFAULT '1d' NOT NULL,
	`file_name` text,
	`rows_imported` integer,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	`phase` text,
	`candles_ms` integer,
	`facts_json` text,
	`failed_symbols_json` text
);
--> statement-breakpoint
CREATE TABLE `external_api_daily_usage` (
	`api` text NOT NULL,
	`quota_scope` text NOT NULL,
	`usage_date_kst` text NOT NULL,
	`calls_used` integer DEFAULT 0 NOT NULL,
	`quota_exceeded_at_ms` integer,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`api`, `quota_scope`, `usage_date_kst`)
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`ip` text NOT NULL,
	`success` integer NOT NULL,
	`attempted_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`read` integer DEFAULT false NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preparation_preview_cache` (
	`job_id` text PRIMARY KEY NOT NULL,
	`data_revision` integer NOT NULL,
	`validation_version` text NOT NULL,
	`fundamental_symbols_json` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `preparation_wizard_references` (
	`user_id` text PRIMARY KEY NOT NULL,
	`context` text NOT NULL,
	`preparation_job_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preparation_job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pending_totp` integer DEFAULT false NOT NULL,
	`created_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `symbol_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`slice` text NOT NULL,
	`first_ts_ms` integer,
	`last_ts_ms` integer,
	`bar_count` integer DEFAULT 0 NOT NULL,
	`expected_bar_count` integer,
	`missing_ranges_json` text,
	`computed_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_slices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`slice` text NOT NULL,
	`synced_first_ts_ms` integer,
	`synced_last_ts_ms` integer,
	`backfill_done_at_ms` integer,
	`last_synced_at_ms` integer
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`totp_last_used_step` integer,
	`recovery_code_hashes_json` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backtest_runs_job_id_unique` ON `backtest_runs` (`job_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `backtest_validation_trials_job_id_unique` ON `backtest_validation_trials` (`job_id`);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_time` ON `audit_logs` (`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_clone_batch_items_pending` ON `backtest_clone_batch_items` (`batch_id`,`state`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_clone_batches_created` ON `backtest_clone_batches` (`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_clone_batches_preparation` ON `backtest_clone_batches` (`preparation_job_id`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_clone_batches_status` ON `backtest_clone_batches` (`status`,`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_drawdown_job` ON `backtest_drawdown_points` (`job_id`,`ts_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_equity_job` ON `backtest_equity_points` (`job_id`,`ts_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_jobs_created` ON `backtest_jobs` (`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_jobs_preparation` ON `backtest_jobs` (`preparation_job_id`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_jobs_status` ON `backtest_jobs` (`status`,`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_monthly_job` ON `backtest_monthly_returns` (`job_id`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_trades_job` ON `backtest_trades` (`job_id`,`exit_ts_ms`);
--> statement-breakpoint
CREATE INDEX `idx_backtest_wizard_drafts_updated` ON `backtest_wizard_drafts` (`updated_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_data_sync_jobs_status` ON `data_sync_jobs` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_external_api_daily_usage_date` ON `external_api_daily_usage` (`usage_date_kst`);
--> statement-breakpoint
CREATE INDEX `idx_login_attempts_username_time` ON `login_attempts` (`username`,`attempted_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_notifications_created` ON `notifications` (`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_preparation_wizard_job` ON `preparation_wizard_references` (`preparation_job_id`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_symbol_coverage_code_slice` ON `symbol_coverage` (`code`,`slice`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_symbol_slices_code_slice` ON `symbol_slices` (`code`,`slice`);
--> statement-breakpoint
CREATE INDEX `idx_validation_source` ON `backtest_validations` (`source_job_id`);
--> statement-breakpoint
CREATE INDEX `idx_validation_trial_parent` ON `backtest_validation_trials` (`validation_id`,`fold`);
--> statement-breakpoint
CREATE INDEX `idx_validation_trial_preparation` ON `backtest_validation_trials` (`preparation_job_id`);
--> statement-breakpoint
CREATE INDEX `preparation_jobs_hash_idx` ON `backtest_preparation_jobs` (`request_hash`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_backtest_clone_batch_item_job` ON `backtest_clone_batch_items` (`job_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_backtest_clone_batch_item_ordinal` ON `backtest_clone_batch_items` (`batch_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_backtest_clone_batch_item_seed` ON `backtest_clone_batch_items` (`batch_id`,`random_seed`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
CREATE TRIGGER `preparation_cache_job_update`
AFTER UPDATE OF `preview_json`, `request_json`, `request_hash`, `status` ON `backtest_preparation_jobs`
BEGIN
  DELETE FROM `preparation_preview_cache` WHERE `job_id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TABLE operational_database_state (singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1), dataset_id TEXT NOT NULL);

--> statement-breakpoint
CREATE TABLE `dart_raw_api_snapshots` (
	`code` text NOT NULL,
	`endpoint` text NOT NULL,
	`business_year` integer NOT NULL,
	`report_code` text NOT NULL,
	`fs_div` text NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`fetched_at_ms` integer NOT NULL,
	PRIMARY KEY(`code`, `endpoint`, `business_year`, `report_code`, `fs_div`),
	CONSTRAINT "chk_dart_raw_api_snapshots_endpoint" CHECK("dart_raw_api_snapshots"."endpoint" IN ('FINANCIAL_STATEMENT', 'SHARE_STATUS', 'ISSUANCE_STATUS')),
	CONSTRAINT "chk_dart_raw_api_snapshots_report_code" CHECK("dart_raw_api_snapshots"."report_code" IN ('11013', '11012', '11014', '11011')),
	CONSTRAINT "chk_dart_raw_api_snapshots_fs_div" CHECK("dart_raw_api_snapshots"."fs_div" IN ('CFS', 'OFS', 'NONE'))
);

--> statement-breakpoint
CREATE INDEX `idx_dart_raw_api_snapshots_fetched_at` ON `dart_raw_api_snapshots` (`fetched_at_ms`);
