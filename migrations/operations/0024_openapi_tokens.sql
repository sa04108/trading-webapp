CREATE TABLE `openapi_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`last_used_at_ms` integer,
	`revoked_at_ms` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `openapi_tokens_token_hash_unique` ON `openapi_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_openapi_tokens_owner` ON `openapi_tokens` (`owner_id`,`created_at_ms`);