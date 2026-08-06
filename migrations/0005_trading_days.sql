CREATE TABLE `symbol_master_trading_days` (
	`date` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
-- 기존 데이터 백필: 체크포인트 날짜와 이벤트 effective_date 는 정의상 거래일이다.
INSERT OR IGNORE INTO `symbol_master_trading_days` (`date`)
  SELECT `checkpoint_date` FROM `symbol_master_checkpoints`;
--> statement-breakpoint
INSERT OR IGNORE INTO `symbol_master_trading_days` (`date`)
  SELECT DISTINCT `effective_date` FROM `symbol_master_events`;
