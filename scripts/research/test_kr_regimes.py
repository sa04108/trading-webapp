"""국면 데이터의 정보 시점과 지연 청산 손익 보존을 검증한다."""

import unittest

from analyze_kr_regimes import compare, timestamp
from prepare_kr_regimes import prior_values


class RegimeResearchTests(unittest.TestCase):
    def test_uses_prior_us_session_and_rate_decision(self):
        values, dates = prior_values([("2020-03-13", 1.25), ("2020-03-17", .75)],
                                    ["2020-03-16", "2020-03-17", "2020-03-18"])
        self.assertEqual(values.tolist(), [1.25, 1.25, .75])
        self.assertEqual(dates.tolist(), ["2020-03-13", "2020-03-13", "2020-03-17"])

    def test_missing_prior_observation_fails(self):
        with self.assertRaises(ValueError):
            prior_values([("2020-03-17", .75)], ["2020-03-17"])

    def test_delayed_liquidation_loss_extends_both_windows(self):
        dates = [f"2025-01-{d:02d}" for d in range(6, 12)]
        macro = [{"date": d, "ndxKrw": p, "ndxUsd": p, "regimes": {"high_vol": i == 1}}
                 for i, (d, p) in enumerate(zip(dates, [100, 100, 100, 100, 50, 50]))]
        result = {"id": "fixture", "from": dates[1], "to": dates[-1],
                  "candidate": {"regime": "high_vol"}, "metrics": {"initialCash": 100},
                  "equity": [{"tsMs": timestamp(d), "equity": p} for d, p in zip(dates, [100, 100, 100, 100, 50, 50])],
                  "trades": [{"entryTsMs": timestamp(dates[2]), "exitTsMs": timestamp(dates[4])}],
                  "openPositions": []}
        compared = compare(result, macro)
        self.assertEqual(compared["activeDays"], 3)
        self.assertEqual(compared["activeStrategyPct"], -50)
        self.assertEqual(compared["activeNdxKrwPct"], -50)
        result["trades"] = []
        with self.assertRaisesRegex(ValueError, "구간 밖 손익"):
            compare(result, macro)


if __name__ == "__main__":
    unittest.main()
