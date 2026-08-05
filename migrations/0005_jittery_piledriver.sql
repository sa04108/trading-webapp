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
