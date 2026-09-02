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
CREATE INDEX `idx_backtest_wizard_drafts_updated` ON `backtest_wizard_drafts` (`updated_at_ms`);