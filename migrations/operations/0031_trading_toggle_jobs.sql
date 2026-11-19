CREATE TABLE `trading_toggle_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_slot` integer NOT NULL,
	`deployment_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`action` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`message` text NOT NULL,
	`executor_token` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`finished_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trading_toggle_active_slot` ON `trading_toggle_jobs` (`account_slot`) WHERE "trading_toggle_jobs"."finished_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `trading_toggle_deployment_created` ON `trading_toggle_jobs` (`deployment_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `trading_toggle_finished` ON `trading_toggle_jobs` (`finished_at_ms`);