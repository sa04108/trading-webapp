-- 기존 0000~0038의 최종 스키마와 초기 행을 통합한다.
-- 기존 최신 DB의 적용 이력을 보존하도록 journal의 when 값을 변경하지 않는다.
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
CREATE TABLE `benchmark_daily_values` (
	`benchmark_id` text NOT NULL,
	`date` text NOT NULL,
	`close` real NOT NULL,
	`synced_at_ms` integer NOT NULL,
	PRIMARY KEY(`benchmark_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE `daily_selection_metric_coverage` (
	`date` text PRIMARY KEY NOT NULL,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_selection_metrics` (
	`date` text NOT NULL,
	`standard_code` text NOT NULL,
	`market_cap_krw` text,
	`volume` integer,
	`trading_value_krw` text,
	PRIMARY KEY(`date`, `standard_code`)
);
--> statement-breakpoint
CREATE TABLE `dart_financial_filing_receipts` (
	`receipt_no` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`business_year` integer NOT NULL,
	`receipt_date` text NOT NULL,
	`processed_at_ms` integer NOT NULL,
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade
);
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
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_dart_raw_api_snapshots_endpoint" CHECK("dart_raw_api_snapshots"."endpoint" IN ('FINANCIAL_STATEMENT', 'SHARE_STATUS', 'ISSUANCE_STATUS')),
	CONSTRAINT "chk_dart_raw_api_snapshots_report_code" CHECK("dart_raw_api_snapshots"."report_code" IN ('11013', '11012', '11014', '11011')),
	CONSTRAINT "chk_dart_raw_api_snapshots_fs_div" CHECK("dart_raw_api_snapshots"."fs_div" IN ('CFS', 'OFS', 'NONE'))
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
CREATE TABLE `facts` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`field` text NOT NULL,
	`period_key` text NOT NULL,
	`as_of_ts_ms` integer NOT NULL,
	`value` real NOT NULL,
	`unit` text NOT NULL,
	`corporate_action_before_shares` integer,
	`corporate_action_after_shares` integer,
	PRIMARY KEY(`scope`, `key`, `field`, `period_key`, `as_of_ts_ms`),
	CONSTRAINT "chk_facts_scope" CHECK("facts"."scope" IN ('SYMBOL', 'MACRO'))
);
--> statement-breakpoint
CREATE TABLE `fred_benchmark_coverage` (
	`benchmark_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`synced_at_ms` integer NOT NULL,
	PRIMARY KEY(`benchmark_id`, `start_date`, `end_date`)
);
--> statement-breakpoint
CREATE TABLE `krx_daily_bars` (
	`short_code` text NOT NULL,
	`date` text NOT NULL,
	`market` text NOT NULL,
	`open` integer NOT NULL,
	`high` integer NOT NULL,
	`low` integer NOT NULL,
	`close` integer NOT NULL,
	`volume` integer NOT NULL,
	PRIMARY KEY(`short_code`, `date`)
);
--> statement-breakpoint
CREATE TABLE `krx_non_trading_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `krx_non_trading_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`short_code` text NOT NULL,
	`market` text NOT NULL,
	`last_close` integer NOT NULL
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
CREATE TABLE `preparation_data_revision` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`armed` integer DEFAULT false NOT NULL,
	CONSTRAINT "chk_preparation_revision_singleton" CHECK("preparation_data_revision"."singleton" = 1)
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
	`computed_at_ms` integer NOT NULL,
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `symbol_facts_state` (
	`code` text PRIMARY KEY NOT NULL,
	`covered_years_json` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`action_covered_years_json` text,
	`action_gap_years_json` text,
	`financial_updated_at_ms` integer,
	`action_updated_at_ms` integer,
	`financial_coverage_protocol_json` text,
	`action_coverage_protocol_json` text,
	`action_gap_details_json` text,
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `symbol_master_checkpoint_symbols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checkpoint_id` text NOT NULL,
	`standard_code` text NOT NULL,
	`short_code` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`shares_outstanding` text NOT NULL,
	`instrument_type` text NOT NULL,
	`listed_date` text,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `symbol_master_checkpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `symbol_master_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`checkpoint_date` text NOT NULL,
	`source` text NOT NULL,
	`verified_at_ms` integer,
	`mismatch_json` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_master_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_master_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`effective_date` text NOT NULL,
	`standard_code` text NOT NULL,
	`event_type` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`observed_span_start` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_master_market_caps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`standard_code` text NOT NULL,
	`market_cap_krw` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_master_storage_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`migrated_at_ms` integer,
	CONSTRAINT "chk_sms_singleton" CHECK("symbol_master_storage_state"."singleton" = 1),
	CONSTRAINT "chk_sms_phase" CHECK("symbol_master_storage_state"."phase" IN ('PENDING', 'ACTIVE'))
);
--> statement-breakpoint
CREATE TABLE `symbol_master_trading_days` (
	`date` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_master_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`standard_code` text NOT NULL,
	`valid_from_date` text NOT NULL,
	`valid_to_date` text,
	`short_code` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`shares_outstanding` text NOT NULL,
	`instrument_type` text NOT NULL,
	`listed_date` text,
	`recorded_at_ms` integer NOT NULL,
	CONSTRAINT "chk_smv_valid_range" CHECK("symbol_master_versions"."valid_to_date" IS NULL OR "symbol_master_versions"."valid_to_date" > "symbol_master_versions"."valid_from_date")
);
--> statement-breakpoint
CREATE TABLE `symbol_slices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`slice` text NOT NULL,
	`synced_first_ts_ms` integer,
	`synced_last_ts_ms` integer,
	`backfill_done_at_ms` integer,
	`last_synced_at_ms` integer,
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `symbol_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`slice` text NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `symbols` (
	`code` text PRIMARY KEY NOT NULL,
	`market` text NOT NULL,
	`name` text,
	`created_at_ms` integer NOT NULL,
	`standard_code` text
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
CREATE INDEX `idx_benchmark_daily_values_date` ON `benchmark_daily_values` (`date`);
--> statement-breakpoint
CREATE INDEX `idx_dart_financial_filing_receipts_code_year` ON `dart_financial_filing_receipts` (`code`,`business_year`);
--> statement-breakpoint
CREATE INDEX `idx_dart_raw_api_snapshots_fetched_at` ON `dart_raw_api_snapshots` (`fetched_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_data_sync_jobs_status` ON `data_sync_jobs` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_external_api_daily_usage_date` ON `external_api_daily_usage` (`usage_date_kst`);
--> statement-breakpoint
CREATE INDEX `idx_facts_pit` ON `facts` (`scope`,`key`,`field`,`as_of_ts_ms`);
--> statement-breakpoint
CREATE INDEX `idx_kntd_date` ON `krx_non_trading_days` (`date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kntd_date_code` ON `krx_non_trading_days` (`date`,`short_code`);
--> statement-breakpoint
CREATE INDEX `idx_krx_daily_bars_date` ON `krx_daily_bars` (`date`);
--> statement-breakpoint
CREATE INDEX `idx_login_attempts_username_time` ON `login_attempts` (`username`,`attempted_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_notifications_created` ON `notifications` (`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_preparation_wizard_job` ON `preparation_wizard_references` (`preparation_job_id`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smcs_checkpoint_code` ON `symbol_master_checkpoint_symbols` (`checkpoint_id`,`standard_code`);
--> statement-breakpoint
CREATE INDEX `idx_sme_code_effective` ON `symbol_master_events` (`standard_code`,`effective_date`);
--> statement-breakpoint
CREATE INDEX `idx_sme_effective` ON `symbol_master_events` (`effective_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smmc_date_code` ON `symbol_master_market_caps` (`date`,`standard_code`);
--> statement-breakpoint
CREATE INDEX `idx_smv_asof` ON `symbol_master_versions` (`valid_from_date`,`valid_to_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smv_code_from` ON `symbol_master_versions` (`standard_code`,`valid_from_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smv_open_code` ON `symbol_master_versions` (`standard_code`) WHERE "symbol_master_versions"."valid_to_date" IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_smv_short_code` ON `symbol_master_versions` (`short_code`);
--> statement-breakpoint
CREATE INDEX `idx_smv_valid_to` ON `symbol_master_versions` (`valid_to_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_symbol_coverage_code_slice` ON `symbol_coverage` (`code`,`slice`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_symbol_slices_code_slice` ON `symbol_slices` (`code`,`slice`);
--> statement-breakpoint
CREATE INDEX `idx_symbol_versions_code_slice` ON `symbol_versions` (`code`,`slice`);
--> statement-breakpoint
CREATE INDEX `idx_symbols_market` ON `symbols` (`market`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_symbols_standard_code` ON `symbols` (`standard_code`);
--> statement-breakpoint
CREATE INDEX `idx_validation_source` ON `backtest_validations` (`source_job_id`);
--> statement-breakpoint
CREATE INDEX `idx_validation_trial_parent` ON `backtest_validation_trials` (`validation_id`,`fold`);
--> statement-breakpoint
CREATE INDEX `idx_validation_trial_preparation` ON `backtest_validation_trials` (`preparation_job_id`);
--> statement-breakpoint
CREATE INDEX `preparation_jobs_hash_idx` ON `backtest_preparation_jobs` (`request_hash`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbol_master_checkpoints_checkpoint_date_unique` ON `symbol_master_checkpoints` (`checkpoint_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_backtest_clone_batch_item_job` ON `backtest_clone_batch_items` (`job_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_backtest_clone_batch_item_ordinal` ON `backtest_clone_batch_items` (`batch_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_backtest_clone_batch_item_seed` ON `backtest_clone_batch_items` (`batch_id`,`random_seed`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
INSERT INTO "preparation_data_revision" ("singleton", "revision", "armed") VALUES (1, 0, 0);
--> statement-breakpoint
INSERT INTO "symbol_master_storage_state" ("singleton", "phase", "migrated_at_ms") VALUES (1, 'PENDING', NULL);
--> statement-breakpoint
CREATE TRIGGER `preparation_cache_job_update`
AFTER UPDATE OF `preview_json`, `request_json`, `request_hash`, `status` ON `backtest_preparation_jobs`
BEGIN
  DELETE FROM `preparation_preview_cache` WHERE `job_id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metric_coverage_delete` AFTER DELETE ON `daily_selection_metric_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metric_coverage_insert` AFTER INSERT ON `daily_selection_metric_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metric_coverage_update` AFTER UPDATE ON `daily_selection_metric_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metrics_delete` AFTER DELETE ON `daily_selection_metrics`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metrics_insert` AFTER INSERT ON `daily_selection_metrics`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metrics_update` AFTER UPDATE ON `daily_selection_metrics`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_facts_delete` AFTER DELETE ON `facts`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_facts_insert` AFTER INSERT ON `facts`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_facts_update` AFTER UPDATE ON `facts`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_daily_bars_delete` AFTER DELETE ON `krx_daily_bars`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_daily_bars_insert` AFTER INSERT ON `krx_daily_bars`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_daily_bars_update` AFTER UPDATE ON `krx_daily_bars`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_coverage_delete` AFTER DELETE ON `krx_non_trading_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_coverage_insert` AFTER INSERT ON `krx_non_trading_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_coverage_update` AFTER UPDATE ON `krx_non_trading_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_days_delete` AFTER DELETE ON `krx_non_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_days_insert` AFTER INSERT ON `krx_non_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_days_update` AFTER UPDATE ON `krx_non_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_facts_state_delete` AFTER DELETE ON `symbol_facts_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_facts_state_insert` AFTER INSERT ON `symbol_facts_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_facts_state_update` AFTER UPDATE ON `symbol_facts_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoint_symbols_delete` AFTER DELETE ON `symbol_master_checkpoint_symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoint_symbols_insert` AFTER INSERT ON `symbol_master_checkpoint_symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoint_symbols_update` AFTER UPDATE ON `symbol_master_checkpoint_symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoints_delete` AFTER DELETE ON `symbol_master_checkpoints`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoints_insert` AFTER INSERT ON `symbol_master_checkpoints`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoints_update` AFTER UPDATE ON `symbol_master_checkpoints`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_coverage_delete` AFTER DELETE ON `symbol_master_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_coverage_insert` AFTER INSERT ON `symbol_master_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_coverage_update` AFTER UPDATE ON `symbol_master_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_events_delete` AFTER DELETE ON `symbol_master_events`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_events_insert` AFTER INSERT ON `symbol_master_events`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_events_update` AFTER UPDATE ON `symbol_master_events`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_market_caps_delete` AFTER DELETE ON `symbol_master_market_caps`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_market_caps_insert` AFTER INSERT ON `symbol_master_market_caps`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_market_caps_update` AFTER UPDATE ON `symbol_master_market_caps`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_storage_state_delete` AFTER DELETE ON `symbol_master_storage_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_storage_state_insert` AFTER INSERT ON `symbol_master_storage_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_storage_state_update` AFTER UPDATE ON `symbol_master_storage_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_trading_days_delete` AFTER DELETE ON `symbol_master_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_trading_days_insert` AFTER INSERT ON `symbol_master_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_trading_days_update` AFTER UPDATE ON `symbol_master_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_versions_delete` AFTER DELETE ON `symbol_master_versions`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_versions_insert` AFTER INSERT ON `symbol_master_versions`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_versions_update` AFTER UPDATE ON `symbol_master_versions`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbols_delete` AFTER DELETE ON `symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbols_insert` AFTER INSERT ON `symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbols_update` AFTER UPDATE ON `symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_smv_no_overlap_insert`
BEFORE INSERT ON `symbol_master_versions`
WHEN EXISTS (
	SELECT 1
	FROM `symbol_master_versions` v
	WHERE v.`standard_code` = NEW.`standard_code`
		AND v.`valid_from_date` < COALESCE(NEW.`valid_to_date`, '9999-12-31')
		AND COALESCE(v.`valid_to_date`, '9999-12-31') > NEW.`valid_from_date`
)
BEGIN
	SELECT RAISE(ABORT, 'symbol_master_versions interval overlap');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_smv_no_overlap_update`
BEFORE UPDATE OF `standard_code`, `valid_from_date`, `valid_to_date`
ON `symbol_master_versions`
WHEN EXISTS (
	SELECT 1
	FROM `symbol_master_versions` v
	WHERE v.`id` <> OLD.`id`
		AND v.`standard_code` = NEW.`standard_code`
		AND v.`valid_from_date` < COALESCE(NEW.`valid_to_date`, '9999-12-31')
		AND COALESCE(v.`valid_to_date`, '9999-12-31') > NEW.`valid_from_date`
)
BEGIN
	SELECT RAISE(ABORT, 'symbol_master_versions interval overlap');
END;
