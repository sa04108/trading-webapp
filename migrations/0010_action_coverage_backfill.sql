-- 기존 종목의 자본변동 커버리지를 재무 커버리지로 채운다.
-- 이 브랜치 이전의 `FactSyncService.sync()` 는 재무와 자본변동을 항상 함께 받았다.
-- 결과는 `covered_years_json` 한 곳에만 적었다.
-- 그래서 그 시절의 재무 커버리지가 곧 자본변동 커버리지다.
--
-- 채우지 않으면 `checkCorporateActionCoverage` 가 기존 종목을 전부 미수집으로 본다.
-- 배포 첫날 모든 제출이 400 이 된다.
-- 위저드는 이미 있는 데이터를 다시 받으러 DART 를 수천 번 때린다.
--
-- gap 연도는 채울 수 없다. 그 시절에는 실패 연도를 담을 컬럼 자체가 없었다.
-- 그래서 백필된 종목은 gap 경고 없이 게이트를 통과한다.
-- 이 한계는 D-043 에 적었다.
UPDATE `symbol_facts_state`
   SET `action_covered_years_json` = `covered_years_json`
 WHERE `action_covered_years_json` IS NULL;
