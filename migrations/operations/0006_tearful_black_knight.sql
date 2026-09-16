ALTER TABLE `agent_data_requests` ADD `activity` text;--> statement-breakpoint
ALTER TABLE `agent_data_requests` ADD `progress_unit` text;--> statement-breakpoint
ALTER TABLE `agent_data_requests` ADD `progress_completed` integer;--> statement-breakpoint
ALTER TABLE `agent_data_requests` ADD `progress_total` integer;--> statement-breakpoint
ALTER TABLE `agent_data_requests` ADD `current_item` text;--> statement-breakpoint
ALTER TABLE `agent_data_requests` ADD `activity_started_at_ms` integer;--> statement-breakpoint
ALTER TABLE `agent_data_requests` ADD `last_progress_at_ms` integer;--> statement-breakpoint
ALTER TABLE `agent_preparation_leases` ADD `last_received_at_ms` integer;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `execution_activity` text;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `activity_started_at_ms` integer;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `last_progress_at_ms` integer;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `last_received_at_ms` integer;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `result_transfer_bytes` integer;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `result_transfer_total_bytes` integer;--> statement-breakpoint
ALTER TABLE `backtest_preparation_jobs` ADD `resolution_pass` integer DEFAULT 0 NOT NULL;