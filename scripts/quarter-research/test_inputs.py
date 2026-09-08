"""시세표 파싱과 공개 지연이 결과를 앞당기지 않는지 검사한다."""

import unittest

import numpy as np

from prepare_inputs import lagged_values
from reconcile_etf_prices import parse_table


class InputTests(unittest.TestCase):
    def test_release_lag(self):
        values, dates = lagged_values([("2026-01-01", 90), ("2026-01-08", 120)], ["2026-01-14", "2026-01-15"], 7)
        np.testing.assert_equal(values, [90, 120])
        self.assertEqual(dates, ["2026-01-01", "2026-01-08"])

    def test_no_future_fill(self):
        with self.assertRaises(ValueError):
            lagged_values([("2026-01-08", 120)], ["2026-01-08"], 1)

    def test_raw_table_prices(self):
        raw = "<tr><td>2026.09.08</td><td>10,050</td><td>상승 50</td><td>10,000</td><td>10,100</td><td>9,990</td><td>3,000</td></tr>".encode("euc-kr")
        self.assertEqual(parse_table(raw)["20260908"], {"open": 10000, "high": 10100, "low": 9990, "close": 10050, "volume": 3000})

    def test_invalid_candle_rejected(self):
        raw = "<tr><td>2026.09.08</td><td>10,500</td><td>상승 50</td><td>10,000</td><td>10,100</td><td>9,990</td><td>3,000</td></tr>".encode("euc-kr")
        with self.assertRaises(ValueError):
            parse_table(raw)

    def test_zero_trade_quote_is_preserved_outside_candles(self):
        raw = "<tr><td>2026.08.24</td><td>83,800</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>".encode()
        with self.assertRaises(ValueError):
            parse_table(raw)
        nontrading = {}
        self.assertEqual(parse_table(raw, nontrading=nontrading), {})
        self.assertEqual(nontrading["20260824"]["close"], 83800)
        with self.assertRaises(ValueError):
            parse_table(b"<html>empty page</html>", nontrading=nontrading)
        with self.assertRaises(ValueError):
            parse_table(raw.replace(b"<td>0</td></tr>", b"<td>141</td></tr>"), nontrading={})


class CurrentHistoryTests(unittest.TestCase):
    def test_history_gap_before_previous_source_end_is_detected(self):
        from prepare_current_inputs import missing_history_sessions
        days = ["2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"]
        self.assertEqual(missing_history_sessions(days, {days[0], days[3]}, set()), days[1:3])

    def test_prelisting_and_documented_nontrading_are_not_filled(self):
        from prepare_current_inputs import missing_history_sessions
        days = ["2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"]
        self.assertEqual(missing_history_sessions(days, {days[1], days[3]}, {days[2]}), [])


    def test_current_corporate_action_requires_fresh_warmup(self):
        from datetime import date, timedelta
        import gzip
        import json
        from pathlib import Path
        import tempfile
        from prepare_current_inputs import prepare
        days = [(date(2026, 1, 1) + timedelta(days=i)).isoformat() for i in range(260)]
        def timestamp(day):
            from datetime import datetime, timezone
            return int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp() * 1000)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stock = {"candles": [{"symbol": "A", "tsMs": timestamp(d), "open": 100, "high": 100, "low": 100, "close": 100, "volume": 1000} for d in days[:249]],
                     "nontrading": [], "metadata": {}, "uncertainActions": [{"symbol": "A", "date": days[249], "type": "unresolved", "ratio": .8}]}
            (root / "stock.gz").write_bytes(gzip.compress(json.dumps(stock).encode()))
            (root / "etf.gz").write_bytes(gzip.compress(json.dumps({"days": days, "macro": [{"date": d} for d in days]}).encode()))
            quotes = {d.replace("-", ""): {"open": 100 if d == days[248] else 150, "high": 100 if d == days[248] else 150,
                       "low": 100 if d == days[248] else 150, "close": 100 if d == days[248] else 150, "volume": 1000} for d in days[248:]}
            (root / "manifest.json").write_text(json.dumps({"asof": days[-1], "selected": [{"symbol": "A", "market": "KOSPI"}], "tables": {"A": quotes}}))
            paths = [root / p for p in ("stock.gz", "etf.gz", "manifest.json", "current.gz")]
            with self.assertRaisesRegex(ValueError, "단위 변화"):
                prepare(*paths)
            prepare(*paths, quarantine_unresolved=True)
            result = json.loads(gzip.decompress(paths[-1].read_bytes()))
            self.assertEqual(len(result["candles"]), 11)
            self.assertEqual(result["candles"][0]["tsMs"], timestamp(days[249]))
            self.assertEqual(result["metadata"]["currentHistoryQuarantines"], stock["uncertainActions"])


if __name__ == "__main__":
    unittest.main()
