-- 자본변동 비율의 분모를 공시 접수일 기준으로 고르던 버그로 이미 저장된 값은
-- 올바른 값과 구분할 수 없다. 파생 팩트와 자본변동 커버리지만 비워 다음 준비에서
-- DART 원본으로 다시 계산한다. 재무 팩트와 재무 커버리지는 유지한다.
DELETE FROM `facts` WHERE `field` = 'SPLIT_RATIO';
--> statement-breakpoint
UPDATE `symbol_facts_state`
   SET `action_covered_years_json` = '[]',
       `action_gap_years_json` = '[]';
