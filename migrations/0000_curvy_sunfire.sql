CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`event` text NOT NULL,
	`detail_json` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_time` ON `audit_logs` (`created_at_ms`);--> statement-breakpoint
CREATE TABLE `backtest_drawdown_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`ts_ms` integer NOT NULL,
	`drawdown` real NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_drawdown_job` ON `backtest_drawdown_points` (`job_id`,`ts_ms`);--> statement-breakpoint
CREATE TABLE `backtest_equity_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`ts_ms` integer NOT NULL,
	`equity` real NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_equity_job` ON `backtest_equity_points` (`job_id`,`ts_ms`);--> statement-breakpoint
CREATE TABLE `backtest_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`request_json` text NOT NULL,
	`strategy_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`dataset_version` integer,
	`dataset_hash` text,
	`progress_bars` integer,
	`total_bars` integer,
	`progress_label` text,
	`error` text,
	`worker_id` text,
	`pid` integer,
	`created_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`completed_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_jobs_status` ON `backtest_jobs` (`status`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_backtest_jobs_created` ON `backtest_jobs` (`created_at_ms`);--> statement-breakpoint
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
CREATE INDEX `idx_backtest_monthly_job` ON `backtest_monthly_returns` (`job_id`);--> statement-breakpoint
CREATE TABLE `backtest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`strategy_version` text NOT NULL,
	`strategy_source_hash` text NOT NULL,
	`parameter_json` text NOT NULL,
	`dataset_id` text NOT NULL,
	`dataset_version` integer NOT NULL,
	`dataset_hash` text NOT NULL,
	`engine_version` text NOT NULL,
	`fee_model_version` text NOT NULL,
	`slippage_model_version` text NOT NULL,
	`random_seed` integer NOT NULL,
	`git_commit_sha` text NOT NULL,
	`warnings_json` text,
	`started_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backtest_runs_job_id_unique` ON `backtest_runs` (`job_id`);--> statement-breakpoint
CREATE TABLE `backtest_symbol_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`symbol` text NOT NULL,
	`trade_count` integer NOT NULL,
	`net_pnl` real NOT NULL,
	`win_rate` real,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_symbol_job` ON `backtest_symbol_metrics` (`job_id`);--> statement-breakpoint
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
CREATE INDEX `idx_backtest_trades_job` ON `backtest_trades` (`job_id`,`exit_ts_ms`);--> statement-breakpoint
CREATE TABLE `data_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dataset_id` text NOT NULL,
	`symbol` text NOT NULL,
	`first_ts_ms` integer,
	`last_ts_ms` integer,
	`bar_count` integer DEFAULT 0 NOT NULL,
	`expected_bar_count` integer,
	`missing_ranges_json` text,
	`computed_at_ms` integer NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_data_coverage_dataset_symbol` ON `data_coverage` (`dataset_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `data_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`status` text NOT NULL,
	`source_type` text NOT NULL,
	`file_name` text,
	`symbol` text,
	`rows_imported` integer,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_data_import_jobs_dataset` ON `data_import_jobs` (`dataset_id`);--> statement-breakpoint
CREATE TABLE `dataset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`note` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dataset_versions_dataset` ON `dataset_versions` (`dataset_id`);--> statement-breakpoint
CREATE TABLE `datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`timeframe` text NOT NULL,
	`symbols_json` text NOT NULL,
	`description` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasets_name_unique` ON `datasets` (`name`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`ip` text NOT NULL,
	`success` integer NOT NULL,
	`attempted_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_login_attempts_username_time` ON `login_attempts` (`username`,`attempted_at_ms`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pending_totp` integer DEFAULT false NOT NULL,
	`created_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`recovery_code_hashes_json` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);