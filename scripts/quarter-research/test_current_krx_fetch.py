"""보존한 날짜를 다시 요청하지 않고 필요한 KRX 원문만 수집하는지 확인한다."""

from contextlib import redirect_stderr
import gzip
from io import BytesIO, StringIO
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fetch_current_krx import collection_days, fetch


class CurrentKrxFetchTests(unittest.TestCase):
    def test_default_request_dates_preserve_existing_snapshot(self):
        expected = ["20260818", "20260819", "20260820", "20260824", "20260904", "20260907", "20260908"]
        self.assertEqual(collection_days("20260908"), expected)
        self.assertEqual(collection_days("20260907"), expected[:-1])

    def test_invalid_or_duplicate_dates_are_rejected(self):
        for days in ([], "20260908", ["20260909"], ["20260907", "20260907"], ["20260908", "20260907"], [None]):
            with self.subTest(days=days), self.assertRaisesRegex(ValueError, "허용 스냅샷"):
                collection_days("20260908", days)
        with self.assertRaises(ValueError):
            collection_days("20260907", ["20260908"])

    def test_latest_only_fetch_requests_each_market_once_and_preserves_raw_rows(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "usage.sqlite"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE external_api_daily_usage (api TEXT, quota_scope TEXT, usage_date_kst TEXT, calls_used INTEGER, quota_exceeded_at_ms INTEGER)")
            env = root / "app.env"
            env.write_text(f"KRX_API_KEY=fixture-key\nKRX_APPROVAL_EXPIRY=2099-01-01\nDATABASE_PATH={database}\n")
            requests, output = [], BytesIO()

            def respond(request, timeout):
                self.assertEqual(timeout, 25)
                self.assertEqual(request.get_header("Auth_key"), "fixture-key")
                requests.append(request.full_url)
                return BytesIO(json.dumps({"OutBlock_1": [{"BAS_DD": "20260908", "ISU_CD": "fixture"}]}).encode())

            with patch("fetch_current_krx.urllib.request.urlopen", side_effect=respond), patch("fetch_current_krx.time.sleep"), \
                    patch("fetch_current_krx.sys.stdout", SimpleNamespace(buffer=output)), redirect_stderr(StringIO()):
                self.assertTrue(fetch(env, days=["20260908"]))
            self.assertEqual(requests, [f"https://data-dbg.krx.co.kr/svc/apis/sto/{market}_bydd_trd?basDd=20260908" for market in ("stk", "ksq")])
            records = [json.loads(line) for line in gzip.decompress(output.getvalue()).splitlines()]
            self.assertEqual(records[0]["dates"], ["20260908"])
            self.assertEqual([r["market"] for r in records if "response" in r], ["KOSPI", "KOSDAQ"])
            self.assertEqual(records[-1], {"complete": True, "calls": 2})
            self.assertEqual([r["response"]["OutBlock_1"][0]["BAS_DD"] for r in records if "response" in r], ["20260908", "20260908"])
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM external_api_daily_usage").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
