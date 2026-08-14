CREATE TABLE `fact_storage_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`migrated_at_ms` integer,
	CONSTRAINT "chk_fact_storage_singleton" CHECK("fact_storage_state"."singleton" = 1),
	CONSTRAINT "chk_fact_storage_phase" CHECK("fact_storage_state"."phase" IN ('PENDING', 'ACTIVE'))
);
--> statement-breakpoint
CREATE TABLE `facts` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`field` text NOT NULL,
	`period_key` text NOT NULL,
	`as_of_ts_ms` integer NOT NULL,
	`value` real NOT NULL,
	`unit` text NOT NULL,
	PRIMARY KEY(`scope`, `key`, `field`, `period_key`, `as_of_ts_ms`),
	CONSTRAINT "chk_facts_scope" CHECK("facts"."scope" IN ('SYMBOL', 'MACRO'))
);
--> statement-breakpoint
CREATE INDEX `idx_facts_pit` ON `facts` (`scope`,`key`,`field`,`as_of_ts_ms`);