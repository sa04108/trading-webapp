"""추가 과거 조회의 날짜 범위·사용량 중단·인증정보 비출력을 확인한다."""

from datetime import datetime, timedelta, timezone
import gzip
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fetch_earlier_krx import fetch, validate_days


class EarlierKrxTests(unittest.TestCase):
    def test_dates_are_bounded_sorted_and_unique(self):
        self.assertEqual(validate_days(["20110103", "20110907"]), ["20110103", "20110907"])
        for days in ([], ["20110907", "20110103"], ["20110907", "20110907"], ["20150201"], ["20110230"]):
            with self.subTest(days=days), self.assertRaises(ValueError):
                validate_days(days)

    def run_fetch(self, used, error=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "usage.sqlite"
            c = sqlite3.connect(path)
            c.execute("CREATE TABLE external_api_daily_usage(api TEXT, quota_scope TEXT, usage_date_kst TEXT, calls_used INTEGER, quota_exceeded_at_ms INTEGER)")
            today = (datetime.now(timezone.utc) + timedelta(hours=9)).date().isoformat()
            c.execute("INSERT INTO external_api_daily_usage VALUES('KRX','/svc/apis/sto/stk_bydd_trd',?,?,NULL)", (today, used))
            c.commit()
            c.close()
            env = root / "app.env"
            env.write_text(f"KRX_API_KEY=sentinel_not_a_real_secret\nDATABASE_PATH={path}\nKRX_APPROVAL_EXPIRY=9999-12-31\n")
            output = io.BytesIO()
            with patch("fetch_earlier_krx.sys.stdout", SimpleNamespace(buffer=output)), patch("fetch_earlier_krx.urllib.request.urlopen", side_effect=error) as request:
                success = fetch(env, ["20110907"], ["daily"])
            decoded = gzip.decompress(output.getvalue()).decode()
            with sqlite3.connect(path) as c:
                self.assertEqual(c.execute("SELECT calls_used FROM external_api_daily_usage").fetchone()[0], used)
            self.assertNotIn("sentinel_not_a_real_secret", decoded)
            return success, [json.loads(line) for line in decoded.splitlines()], request.call_count

    def test_recorded_quota_stops_before_network_without_mutating_usage(self):
        success, rows, count = self.run_fetch(9000)
        self.assertFalse(success)
        self.assertEqual(count, 0)
        self.assertEqual(rows[-1]["reason"], "운영 사용량 또는 한도 중단 기록")

    def test_request_error_is_preserved_without_exception_text_or_usage_write(self):
        success, rows, count = self.run_fetch(0, RuntimeError("sentinel_not_a_real_secret"))
        self.assertFalse(success)
        self.assertEqual(count, 1)
        self.assertEqual(rows[-1]["errorType"], "RuntimeError")
        self.assertFalse(rows[-1]["complete"])


if __name__ == "__main__":
    unittest.main()
