DELETE FROM `krx_daily_bars`
WHERE `open` = 0
  AND `high` = 0
  AND `low` = 0
  AND `close` > 0
  AND `volume` = 0
  AND EXISTS (
    SELECT 1
    FROM `krx_non_trading_days`
    WHERE `krx_non_trading_days`.`short_code` = `krx_daily_bars`.`short_code`
      AND `krx_non_trading_days`.`date` = `krx_daily_bars`.`date`
  );
