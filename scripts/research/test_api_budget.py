"""운영 API 예산이 부족하면 외부 요청 없이 수집을 중단하는지 검증한다."""
import gzip
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from fetch_dart_annual import fetch


class APIBudgetTests(unittest.TestCase):
    def test_quota_exhaustion_makes_no_http_request(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'usage.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE external_api_daily_usage(api TEXT,quota_scope TEXT,usage_date_kst TEXT,calls_used INTEGER)')
                day = time.strftime('%Y-%m-%d',time.gmtime(time.time()+9*3600))
                db.execute('INSERT INTO external_api_daily_usage VALUES(?,?,?,?)',('DART','daily',day,39897))
            before = path.read_bytes()
            output = io.BytesIO()
            with patch('fetch_dart_annual.sys.stdout',SimpleNamespace(buffer=output)),patch('fetch_dart_annual.urllib.request.urlopen') as request:
                fetch(['00126380'],'test-key',path)
            request.assert_not_called()
            records = [json.loads(line) for line in gzip.decompress(output.getvalue()).decode().splitlines()]
            self.assertEqual(records[-1],{'complete':False,'calls':0})
            self.assertEqual(before,path.read_bytes())
            self.assertNotIn('test-key',gzip.decompress(output.getvalue()).decode())


if __name__=='__main__':
    unittest.main()
