CREATE TABLE `corporate_action_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`symbols_json` text NOT NULL,
	`from_year` integer NOT NULL,
	`to_year` integer NOT NULL,
	`done_symbols` integer DEFAULT 0 NOT NULL,
	`total_symbols` integer NOT NULL,
	`saved_facts` integer,
	`gap_count` integer,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`completed_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `idx_corporate_action_sync_jobs_status` ON `corporate_action_sync_jobs` (`status`);