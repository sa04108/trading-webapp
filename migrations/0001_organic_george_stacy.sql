CREATE TABLE `broker_sync_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dataset_id` text NOT NULL,
	`symbol` text NOT NULL,
	`synced_first_ts_ms` integer,
	`synced_last_ts_ms` integer,
	`backfill_done_at_ms` integer,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_broker_sync_state_dataset_symbol` ON `broker_sync_state` (`dataset_id`,`symbol`);