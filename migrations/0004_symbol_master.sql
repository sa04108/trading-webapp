-- 스펙 2026-08-05: 종목 마스터(point-in-time security master) 전환을 한 단계로 묶는다.
-- 새 테이블 생성 → 백테스트 유니버스 컬럼 교체 → 데이터셋·스냅샷 테이블 제거 순서다.
CREATE TABLE `symbol_master_checkpoint_symbols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checkpoint_id` text NOT NULL,
	`standard_code` text NOT NULL,
	`short_code` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`shares_outstanding` text NOT NULL,
	`instrument_type` text NOT NULL,
	`listed_date` text,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `symbol_master_checkpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smcs_checkpoint_code` ON `symbol_master_checkpoint_symbols` (`checkpoint_id`,`standard_code`);--> statement-breakpoint
CREATE TABLE `symbol_master_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`checkpoint_date` text NOT NULL,
	`source` text NOT NULL,
	`verified_at_ms` integer,
	`mismatch_json` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbol_master_checkpoints_checkpoint_date_unique` ON `symbol_master_checkpoints` (`checkpoint_date`);--> statement-breakpoint
CREATE TABLE `symbol_master_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_master_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`effective_date` text NOT NULL,
	`standard_code` text NOT NULL,
	`event_type` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`observed_span_start` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sme_effective` ON `symbol_master_events` (`effective_date`);--> statement-breakpoint
CREATE INDEX `idx_sme_code_effective` ON `symbol_master_events` (`standard_code`,`effective_date`);--> statement-breakpoint
CREATE TABLE `symbol_master_market_caps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`standard_code` text NOT NULL,
	`market_cap_krw` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smmc_date_code` ON `symbol_master_market_caps` (`date`,`standard_code`);
--> statement-breakpoint
-- 스펙 2026-08-05: 백테스트 유니버스가 datasetId/universeSnapshotId 참조에서
-- universeRule(유니버스 규칙) + universeScheduleJson(멤버십 일정) pin 으로 바뀐다.
-- 옛 컬럼을 NOT NULL 신규 컬럼으로 대체하므로 기존 백테스트 잡·런 데이터는 보존하지
-- 않는다(사용자 승인 — 개발 단계 데이터, 계획 문서 Global Constraints 참고). FK
-- cascade(backtest_runs 등은 backtest_jobs.id ON DELETE CASCADE) 로 backtest_jobs 하나만
-- 지워도 충분하지만, 마이그레이션 스크립트 자체가 무엇을 지우는지 드러나도록 자식
-- 테이블부터 명시적으로 비운다.
DELETE FROM `backtest_trades`;--> statement-breakpoint
DELETE FROM `backtest_symbol_metrics`;--> statement-breakpoint
DELETE FROM `backtest_monthly_returns`;--> statement-breakpoint
DELETE FROM `backtest_drawdown_points`;--> statement-breakpoint
DELETE FROM `backtest_equity_points`;--> statement-breakpoint
DELETE FROM `backtest_metrics`;--> statement-breakpoint
DELETE FROM `backtest_runs`;--> statement-breakpoint
DELETE FROM `backtest_jobs`;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `universe_rule_json` text NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `universe_schedule_json` text NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `universe_rule_json` text NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `schedule_hash` text NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` DROP COLUMN `dataset_id`;--> statement-breakpoint
ALTER TABLE `backtest_jobs` DROP COLUMN `universe_snapshot_id`;--> statement-breakpoint
ALTER TABLE `backtest_runs` DROP COLUMN `dataset_id`;
--> statement-breakpoint
DROP TABLE `dataset_symbols`;--> statement-breakpoint
DROP TABLE `datasets`;--> statement-breakpoint
DROP TABLE `universe_snapshot_symbols`;--> statement-breakpoint
DROP TABLE `universe_snapshots`;
