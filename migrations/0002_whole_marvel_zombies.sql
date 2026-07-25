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
	`progress_bars` integer,
	`total_bars` integer,
	`current_symbol` text,
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
CREATE INDEX `idx_backtest_trades_job` ON `backtest_trades` (`job_id`,`exit_ts_ms`);