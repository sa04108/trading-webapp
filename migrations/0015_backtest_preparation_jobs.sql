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
	`completed_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `preparation_jobs_hash_idx` ON `backtest_preparation_jobs` (`request_hash`,`status`);--> statement-breakpoint
DROP TABLE `corporate_action_sync_jobs`;