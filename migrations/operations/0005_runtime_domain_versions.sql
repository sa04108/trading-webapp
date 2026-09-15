-- 도입 전 결과·실험의 버전은 NULL로 남겨 현재 실행과의 호환성을 추정하지 않는다.
ALTER TABLE `backtest_runs` ADD `execution_version` text;--> statement-breakpoint
ALTER TABLE `backtest_validations` ADD `execution_version` text;--> statement-breakpoint
ALTER TABLE `backtest_validations` ADD `validation_version` text;
