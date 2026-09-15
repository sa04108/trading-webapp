-- 이전 릴리스에서 SCD 변환을 끝낸 DB 또는 비어 있는 신규 DB만 정리한다.
-- 미변환 데이터는 삭제하지 않고 전체 마이그레이션을 중단한다.
CREATE TABLE `_completed_conversion_guard` (
  `ready` INTEGER NOT NULL CONSTRAINT `symbol_master_conversion_required` CHECK (`ready` = 1)
);
--> statement-breakpoint
INSERT INTO `_completed_conversion_guard` (`ready`)
SELECT CASE WHEN
  NOT EXISTS (SELECT 1 FROM symbol_master_checkpoints)
  AND NOT EXISTS (SELECT 1 FROM symbol_master_checkpoint_symbols)
  AND NOT EXISTS (SELECT 1 FROM symbol_master_events)
  AND (
    EXISTS (SELECT 1 FROM symbol_master_storage_state WHERE singleton = 1 AND phase = 'ACTIVE')
    OR (
      NOT EXISTS (SELECT 1 FROM symbol_master_versions)
      AND NOT EXISTS (SELECT 1 FROM symbol_master_trading_days)
      AND NOT EXISTS (SELECT 1 FROM symbol_master_coverage)
    )
  ) THEN 1 ELSE 0 END;
--> statement-breakpoint
DROP TABLE `_completed_conversion_guard`;
--> statement-breakpoint
DROP TABLE `symbol_master_checkpoint_symbols`;--> statement-breakpoint
DROP TABLE `symbol_master_checkpoints`;--> statement-breakpoint
DROP TABLE `symbol_master_events`;--> statement-breakpoint
DROP TABLE `symbol_master_storage_state`;--> statement-breakpoint
ALTER TABLE `symbol_facts_state` DROP COLUMN `updated_at_ms`;
--> statement-breakpoint
-- 값이 같아도 파일 스키마가 바뀌었으므로 에이전트 입력 스냅샷을 다시 게시한다.
UPDATE `dataset_state` SET revision = revision + 1 WHERE singleton = 1;
