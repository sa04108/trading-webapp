"""직전일 실제 거래대금 선정과 빠진 원문 차단을 검증한다."""

from datetime import date, timedelta
import gzip
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from select_current_krx import select


class CurrentKrxTests(unittest.TestCase):
    def fixture(self, root):
        days = [(date(2026, 8, 10) + timedelta(days=i)).isoformat() for i in range(21)]
        panel = root / "panel"
        panel.mkdir()
        np.save(panel / "days.npy", np.array(days[:19]))
        np.save(panel / "codes.npy", np.array(["A", "B"]))
        for field in ("open", "high", "low", "close"):
            np.save(panel / f"{field}.npy", np.full((19, 2), 100.0))
        np.save(panel / "volume.npy", np.full((19, 2), 10_000_000.0))
        np.save(panel / "value.npy", np.tile([900_000_000.0, 1_100_000_000.0], (19, 1)))
        for field in ("common", "active", "nontrading"):
            np.save(panel / f"{field}.npy", np.full((19, 2), field != "nontrading"))
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps({"asof": days[-1], "selected": [{"symbol": "A", "marketCap": 999}, {"symbol": "B", "marketCap": 1}], "tables": {"A": {}, "B": {}}}))
        calendar = root / "calendar.gz"
        calendar.write_bytes(gzip.compress(json.dumps({"days": days}).encode()))
        rows = [{"BAS_DD": days[-2].replace("-", ""), "ISU_CD": code, "MKTCAP": cap,
                 "TDD_OPNPRC": "100", "TDD_HGPRC": "100", "TDD_LWPRC": "100", "TDD_CLSPRC": "100",
                 "ACC_TRDVOL": "10000000", "ACC_TRDVAL": value}
                for code, cap, value in (("A", "200", "900000000"), ("B", "100", "1100000000"))]
        recent = root / "recent.gz"
        recent.write_bytes(gzip.compress(json.dumps({"date": days[-2].replace("-", ""), "response": {"OutBlock_1": rows}}).encode()))
        return manifest, panel, calendar, recent

    def test_actual_value_and_previous_day_membership_are_used(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, panel, calendar, recent = self.fixture(root)
            output = root / "selected.json"
            select(manifest, panel, calendar, [recent], output, size=1)
            result = json.loads(output.read_text())
            self.assertEqual([r["symbol"] for r in result["selected"]], ["B"])
            self.assertEqual(result["selected"][0]["selectionAdv20"], 1_100_000_000)
            self.assertLess(result["selected"][0]["universeAsOf"], result["asof"])

    def test_missing_daily_value_is_not_replaced_by_price_times_volume(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, panel, calendar, recent = self.fixture(root)
            np.save(panel / "days.npy", np.load(panel / "days.npy")[:-1])
            with self.assertRaisesRegex(ValueError, "날짜 누락"):
                select(manifest, panel, calendar, [recent], root / "selected.json", size=1)


if __name__ == "__main__":
    unittest.main()
