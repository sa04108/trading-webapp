ALTER TABLE `symbol_facts_state` ADD `financial_updated_at_ms` integer;--> statement-breakpoint
ALTER TABLE `symbol_facts_state` ADD `action_updated_at_ms` integer;--> statement-breakpoint
UPDATE `symbol_facts_state`
SET `financial_updated_at_ms` = `updated_at_ms`
WHERE `covered_years_json` <> '[]';
--> statement-breakpoint
UPDATE `symbol_facts_state`
SET `action_updated_at_ms` = `updated_at_ms`
WHERE coalesce(`action_covered_years_json`, '[]') <> '[]' OR coalesce(`action_gap_years_json`, '[]') <> '[]';
