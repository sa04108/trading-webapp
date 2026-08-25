ALTER TABLE `symbol_facts_state` ADD `financial_coverage_protocol_json` text;--> statement-breakpoint
ALTER TABLE `symbol_facts_state` ADD `action_coverage_protocol_json` text;--> statement-breakpoint
CREATE INDEX `idx_smv_short_code` ON `symbol_master_versions` (`short_code`);