CREATE TABLE `symbol_master_trading_days` (
	`date` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
-- 기존 데이터 백필. checkpoint_date 는 ingestDate 가 거래일로 판정한 날에만 찍히므로
-- 확실한 거래일이다. 반면 symbol_master_events.effective_date 는 최선 추정일 뿐이다 —
-- 갭 메우기 경로(nextCoverageStart 로 찾은 gapDate)가 만든 이벤트는 그 날짜가 고립된
-- 휴장일 섬(수동 sync 로 휴장일 하루만 커버된 구간)의 시작일일 수 있고, 그러면 이
-- INSERT 가 휴장일을 거래일로 잘못 채운다. 그래도 이 백필은 한 번만 실행되는 이행
-- 조치이고, 이 마이그레이션 이후로는 ingestDate 가 실제 거래일 판정 시점에만
-- symbol_master_trading_days 에 쓰므로 이 부정확성은 과거 데이터로 한정된다.
INSERT OR IGNORE INTO `symbol_master_trading_days` (`date`)
  SELECT `checkpoint_date` FROM `symbol_master_checkpoints`;
--> statement-breakpoint
INSERT OR IGNORE INTO `symbol_master_trading_days` (`date`)
  SELECT DISTINCT `effective_date` FROM `symbol_master_events`;
