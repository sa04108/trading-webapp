"""수출 관측의 가정된 공개 지연과 실제 달력 기간의 중첩 제거를 검사한다."""

from pathlib import Path
import tempfile
import unittest

from analyze_context import export_history, known_export, nonoverlapping


class ContextTests(unittest.TestCase):
    def test_month_start_plus_ninety_days(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "exports.csv"
            source.write_text("observation_date,value\n2025-06-01,100\n2026-06-01,170\n")
            rows = export_history(source)
            self.assertIsNone(known_export(rows, "2026-08-29"))
            self.assertAlmostEqual(known_export(rows, "2026-08-30")["yoy"], .7)

    def test_calendar_quarters_can_overlap(self):
        rows = [{"start": "2020-01-06", "end": "2020-04-05"},
                {"start": "2020-04-01", "end": "2020-06-30"},
                {"start": "2020-05-04", "end": "2020-08-03"}]
        self.assertEqual([r["start"] for r in nonoverlapping(rows)], ["2020-01-06", "2020-05-04"])


if __name__ == "__main__":
    unittest.main()
