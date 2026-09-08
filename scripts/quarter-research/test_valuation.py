"""순이익 누적 차분·중복 계정·기말 자본총계의 의미를 검증한다."""

import unittest

from prepare_quarterly import normalize
from prepare_valuation import normalize_equity
from test_quarterly import row


class ValuationTests(unittest.TestCase):
    def test_net_income_duplicate_is_deduplicated_and_cumulative_is_not_quarter(self):
        first = row("11013", 100_000_000, 100_000_000, "20250515000001")
        second = row("11012", 150_000_000, 250_000_000, "20250814000001")
        for r in (first, second):
            r["account_nm"] = "당기순이익(손실)"
        values, excluded = normalize([first, second, dict(second)], {"A": "00000001"}, ("당기순이익(손실)",))
        self.assertEqual(excluded, [])
        self.assertEqual(len(values), 2)
        self.assertEqual(values[1]["value"], 150_000_000)

    def test_equity_is_a_quarter_end_balance_not_a_cumulative_difference(self):
        rows = [row("11013", 100_000_000, 0, "20250515000001"),
                row("11012", 110_000_000, 0, "20250814000001")]
        for r in rows:
            r.update(account_nm="자본총계", sj_div="BS")
        values, excluded = normalize_equity(rows, {"A": "00000001"})
        self.assertEqual(excluded, [])
        self.assertEqual(values[1]["value"], 110_000_000)
        self.assertEqual(values[1]["available"], "2025-08-15")

    def test_conflicting_equity_duplicates_are_rejected(self):
        r = row("11012", 100_000_000, 0, "20250814000001")
        r.update(account_nm="자본총계", sj_div="BS")
        values, excluded = normalize_equity([r, {**r, "thstrm_amount": "200000000"}], {"A": "00000001"})
        self.assertEqual(values, [])
        self.assertEqual(excluded[0]["reason"], "같은 기말 자본총계의 값 충돌")


if __name__ == "__main__":
    unittest.main()
