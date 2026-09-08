"""현재 신호와 월별 종목군 자료의 시간 경계를 확인한다."""

from datetime import date, timedelta
from contextlib import redirect_stdout
import gzip
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import numpy as np

from select_current_krx import select, selection_days


class CurrentSelectionTests(unittest.TestCase):
    def setUp(self):
        first = date(2026, 8, 3)
        self.days = [(first + timedelta(days=i)).isoformat() for i in range(37)
                     if (first + timedelta(days=i)).weekday() < 5 and (first + timedelta(days=i)).isoformat() != "2026-08-17"]

    def test_default_uses_twenty_prior_sessions(self):
        days = selection_days(self.days, "2026-09-08")
        self.assertEqual(days, [d for d in self.days if d < "2026-09-08"][-20:])
        self.assertEqual(days[-1], "2026-09-07")
        self.assertNotIn("2026-09-08", days)
        self.assertNotIn("2026-08-17", days)

    def test_monthly_snapshot_keeps_signal_date_and_excludes_later_sessions(self):
        days = selection_days(self.days, "2026-09-08", "2026-08-31")
        self.assertEqual(len(days), 20)
        self.assertEqual((days[0], days[-1]), ("2026-08-03", "2026-08-31"))
        self.assertTrue(all(d < "2026-09-01" for d in days))
        self.assertIn("2026-09-08", self.days)

    def test_future_nontrading_and_short_windows_are_rejected(self):
        for day in ("2026-09-08", "2026-09-09", "2026-08-30", "2026-08-17", "invalid"):
            with self.subTest(day=day), self.assertRaisesRegex(ValueError, "실제 거래일"):
                selection_days(self.days, "2026-09-08", day)
        with self.assertRaisesRegex(ValueError, "20거래일"):
            selection_days(self.days, "2026-09-08", "2026-08-14")


    def test_stored_month_end_cap_uses_then_known_status_and_recent_missing_day(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            stored_days = [d for d in self.days if d <= "2026-09-03" and d != "2026-08-18"]
            np.save(root / "days.npy", np.array(stored_days))
            np.save(root / "codes.npy", np.array(["A", "B"]))
            for field, value in (("value", 2_000_000_000), ("volume", 20_000_000), ("open", 100), ("high", 100), ("low", 100), ("close", 100)):
                np.save(root / f"{field}.npy", np.full((len(stored_days), 2), value, dtype=float))
            np.save(root / "common.npy", np.ones((len(stored_days), 2), dtype=bool))
            active = np.ones((len(stored_days), 2), dtype=bool)
            active[-1, 1] = False
            np.save(root / "active.npy", active)
            np.save(root / "nontrading.npy", np.zeros((len(stored_days), 2), dtype=bool))
            np.save(root / "cap.npy", np.tile([100, 200], (len(stored_days), 1)))
            table = {d.replace("-", ""): {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 20_000_000} for d in self.days}
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"asof": "2026-09-08", "selected": [{"symbol": "A"}, {"symbol": "B"}], "tables": {"A": table, "B": table}}))
            calendar = root / "calendar.gz"
            calendar.write_bytes(gzip.compress(json.dumps({"days": self.days}).encode()))
            recent = root / "recent.gz"
            blocks = []
            for day in self.days:
                if day in stored_days or day >= "2026-09-08":
                    continue
                raw_day = day.replace("-", "")
                rows = [{"BAS_DD": raw_day, "ISU_CD": code, "MKTCAP": str(cap), "TDD_OPNPRC": "100", "TDD_HGPRC": "100", "TDD_LWPRC": "100",
                         "TDD_CLSPRC": "100", "ACC_TRDVOL": "20000000", "ACC_TRDVAL": "2000000000"} for code, cap in (("A", 300), ("B", 150))]
                blocks.append({"date": raw_day, "response": {"OutBlock_1": rows}})
            recent.write_bytes(gzip.compress("\n".join(json.dumps(b) for b in blocks).encode()))
            with redirect_stdout(StringIO()):
                select(manifest, root, calendar, [recent], root / "daily.json", size=1)
                select(manifest, root, calendar, [recent], root / "monthly.json", size=1, universe_asof="2026-08-31")
            daily = json.loads((root / "daily.json").read_text())
            monthly = json.loads((root / "monthly.json").read_text())
            self.assertEqual(daily["selected"][0]["symbol"], "A")
            self.assertEqual(monthly["selected"][0]["symbol"], "B")
            self.assertEqual(monthly["selected"][0]["selectionMarketCap"], "200")
            self.assertEqual(monthly["selected"][0]["universeAsOf"], "2026-08-31")
            self.assertEqual(monthly["asof"], "2026-09-08")
            self.assertEqual(monthly["selected"][0]["selectionAdv20"], 2_000_000_000)


if __name__ == "__main__":
    unittest.main()
