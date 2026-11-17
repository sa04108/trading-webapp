ALTER TABLE `backtest_preparation_jobs` ADD `runtime_versions_json` text;--> statement-breakpoint
ALTER TABLE `backtest_wizard_jobs` ADD `runtime_versions_json` text;--> statement-breakpoint
ALTER TABLE `backtest_wizard_jobs` ADD `recovery_message` text;--> statement-breakpoint
ALTER TABLE `backtest_wizard_jobs` ADD `recovery_error` text;