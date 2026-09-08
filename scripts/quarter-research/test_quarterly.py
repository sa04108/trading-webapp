"""누적액 혼동·회계기준 혼합·미래 정정 공시의 소급을 막는 검증이다."""

import gzip
import json
from pathlib import Path
import tempfile
import unittest

from prepare_quarterly import normalize, prepare


def row(report, current, cumulative, receipt, basis="CFS"):
    end = {"11013": "2025.03.31", "11012": "2025.06.30", "11014": "2025.09.30", "11011": "2025.12.31"}[report]
    return {"stock_code": "A", "corp_code": "00000001", "bsns_year": "2025", "reprt_code": report,
            "fs_div": basis, "currency": "KRW", "thstrm_dt": "2025.01.01 ~ " + end,
            "rcept_no": receipt, "account_nm": "영업이익", "thstrm_amount": str(current), "thstrm_add_amount": str(cumulative)}


class QuarterlyTests(unittest.TestCase):
    def test_half_year_is_not_a_standalone_quarter(self):
        rows = [row("11013", 100_000_000, 100_000_000, "20250515000001"),
                row("11012", 150_000_000, 250_000_000, "20250814000001")]
        values, excluded = normalize(rows, {"A": "00000001"})
        self.assertEqual(excluded, [])
        self.assertEqual(values[1]["value"], 150_000_000)
        self.assertEqual(values[1]["available"], "2025-08-15")

    def test_annual_minus_nine_month_uses_later_receipt(self):
        rows = [row("11014", 100_000_000, 350_000_000, "20260701000001"),
                row("11011", 550_000_000, 0, "20260320000001")]
        values, _ = normalize(rows, {"A": "00000001"})
        self.assertEqual(values[0]["periodKey"], "2025Q4")
        self.assertEqual(values[0]["value"], 200_000_000)
        self.assertEqual(values[0]["available"], "2026-07-02")

    def test_mixed_basis_and_material_restated_difference_are_excluded(self):
        first = row("11013", 100_000_000, 100_000_000, "20250515000001")
        second = row("11012", 150_000_000, 300_000_000, "20250814000001")
        values, excluded = normalize([first, second], {"A": "00000001"})
        self.assertEqual(len(values), 1)
        self.assertEqual(excluded[0]["reason"], "당기액과 누적 차분 불일치")
        second["fs_div"] = "OFS"
        values, excluded = normalize([first, second], {"A": "00000001"})
        self.assertEqual(len(values), 1)
        self.assertEqual(excluded[0]["reason"], "같은 연도·기준의 직전 누적액 누락")

    def test_response_must_match_requested_year_report_and_company(self):
        wrong = row("11013", 100_000_000, 100_000_000, "20250515000001")
        blocks = [{"format": 1}, {"year": 2024, "report": "11013", "requested": ["00000001"],
                                 "response": {"status": "000", "list": [wrong]}}, {"complete": True}]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            raw = root / "raw.gz"
            raw.write_bytes(gzip.compress("\n".join(json.dumps(b) for b in blocks).encode()))
            with self.assertRaisesRegex(ValueError, "요청한 연도"):
                prepare(raw, root / "mapping.json", root / "result.json")


if __name__ == "__main__":
    unittest.main()
