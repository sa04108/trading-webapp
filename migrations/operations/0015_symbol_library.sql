CREATE TABLE `symbol_directory` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`source` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_library` (
	`owner_id` text NOT NULL,
	`symbol` text NOT NULL,
	`favorite_at_ms` integer,
	`viewed_at_ms` integer,
	PRIMARY KEY(`owner_id`, `symbol`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `symbol_library_recent` ON `symbol_library` (`owner_id`,`viewed_at_ms`);