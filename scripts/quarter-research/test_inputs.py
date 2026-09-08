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


if __name__ == "__main__":
    unittest.main()
