CREATE TABLE `symbol_master_storage_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`migrated_at_ms` integer,
	CONSTRAINT "chk_sms_singleton" CHECK("symbol_master_storage_state"."singleton" = 1),
	CONSTRAINT "chk_sms_phase" CHECK("symbol_master_storage_state"."phase" IN ('PENDING', 'ACTIVE'))
);
--> statement-breakpoint
CREATE TABLE `symbol_master_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`standard_code` text NOT NULL,
	`valid_from_date` text NOT NULL,
	`valid_to_date` text,
	`short_code` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`shares_outstanding` text NOT NULL,
	`instrument_type` text NOT NULL,
	`listed_date` text,
	`recorded_at_ms` integer NOT NULL,
	CONSTRAINT "chk_smv_valid_range" CHECK("symbol_master_versions"."valid_to_date" IS NULL OR "symbol_master_versions"."valid_to_date" > "symbol_master_versions"."valid_from_date")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smv_code_from` ON `symbol_master_versions` (`standard_code`,`valid_from_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smv_open_code` ON `symbol_master_versions` (`standard_code`) WHERE "symbol_master_versions"."valid_to_date" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_smv_asof` ON `symbol_master_versions` (`valid_from_date`,`valid_to_date`);--> statement-breakpoint
CREATE INDEX `idx_smv_valid_to` ON `symbol_master_versions` (`valid_to_date`);--> statement-breakpoint
INSERT INTO `symbol_master_storage_state` (`singleton`, `phase`, `migrated_at_ms`)
VALUES (1, 'PENDING', NULL);--> statement-breakpoint
CREATE TRIGGER `trg_smv_no_overlap_insert`
BEFORE INSERT ON `symbol_master_versions`
WHEN EXISTS (
	SELECT 1
	FROM `symbol_master_versions` v
	WHERE v.`standard_code` = NEW.`standard_code`
		AND v.`valid_from_date` < COALESCE(NEW.`valid_to_date`, '9999-12-31')
		AND COALESCE(v.`valid_to_date`, '9999-12-31') > NEW.`valid_from_date`
)
BEGIN
	SELECT RAISE(ABORT, 'symbol_master_versions interval overlap');
END;--> statement-breakpoint
CREATE TRIGGER `trg_smv_no_overlap_update`
BEFORE UPDATE OF `standard_code`, `valid_from_date`, `valid_to_date`
ON `symbol_master_versions`
WHEN EXISTS (
	SELECT 1
	FROM `symbol_master_versions` v
	WHERE v.`id` <> OLD.`id`
		AND v.`standard_code` = NEW.`standard_code`
		AND v.`valid_from_date` < COALESCE(NEW.`valid_to_date`, '9999-12-31')
		AND COALESCE(v.`valid_to_date`, '9999-12-31') > NEW.`valid_from_date`
)
BEGIN
	SELECT RAISE(ABORT, 'symbol_master_versions interval overlap');
END;
