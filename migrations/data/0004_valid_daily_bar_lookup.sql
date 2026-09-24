CREATE INDEX `idx_krx_daily_bars_valid_code_date` ON `krx_daily_bars` (`short_code`,`date`) WHERE "krx_daily_bars"."market" IN ('KOSPI', 'KOSDAQ')
    AND "krx_daily_bars"."open" > 0 AND "krx_daily_bars"."high" > 0 AND "krx_daily_bars"."low" > 0 AND "krx_daily_bars"."close" > 0
    AND "krx_daily_bars"."volume" >= 0
    AND "krx_daily_bars"."high" >= "krx_daily_bars"."low" AND "krx_daily_bars"."high" >= "krx_daily_bars"."open" AND "krx_daily_bars"."high" >= "krx_daily_bars"."close"
    AND "krx_daily_bars"."low" <= "krx_daily_bars"."open" AND "krx_daily_bars"."low" <= "krx_daily_bars"."close";