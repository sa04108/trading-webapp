"""이전 국면의 보통주 분류와 가격 비교 기준 불연속을 확인한다."""

import unittest
import numpy as np

from prepare_earlier_input import common_stock, monthly_members, reference_discontinuity


class EarlierInputTests(unittest.TestCase):
    def test_common_stock_is_distinct_from_preferred_spac_and_fund(self):
        base = {"SECUGRP_NM": "주권", "KIND_STKCERT_TP_NM": "보통주", "SECT_TP_NM": "", "ISU_NM": "검증회사"}
        self.assertTrue(common_stock(base))
        for change in ({"SECUGRP_NM": "주식예탁증서"}, {"SECUGRP_NM": "투자회사"}, {"SECUGRP_NM": "부동산투자회사"},
                       {"KIND_STKCERT_TP_NM": "구형우선주"}, {"ISU_NM": "검증스팩"}, {"SECT_TP_NM": "SPAC"}):
            self.assertFalse(common_stock(base | change))
        with self.assertRaises(ValueError):
            common_stock(base | {"SECUGRP_NM": "미확인"})

    def test_same_day_rank_changes_wait_for_the_next_monthly_selection(self):
        days = [f"2011-01-{i + 1:02d}" for i in range(23)] + ["2011-02-01"]
        shape = (len(days), 2)
        common, liquidity, volume = np.ones(shape, dtype=bool), np.full(shape, 2e9), np.full(shape, 1000)
        cap = np.tile([200., 100.], (len(days), 1))
        before = monthly_members(days, ["A", "B"], common, liquidity, volume, cap, 1)
        cap[21:, 1] = 500
        after = monthly_members(days, ["A", "B"], common, liquidity, volume, cap, 1)
        self.assertEqual(before[:23], after[:23])
        self.assertEqual(after[21], ["A"])
        self.assertEqual(after[23], ["B"])

    def test_regular_price_changes_do_not_create_a_corporate_action(self):
        self.assertIsNone(reference_discontinuity(100, 103, 3))
        self.assertIsNone(reference_discontinuity(100, 95, -5))
        self.assertIsNone(reference_discontinuity(np.nan, 95, -5))
        self.assertIsNone(reference_discontinuity(100, 0, 0))

    def test_changed_comparison_basis_is_quarantined_without_inventing_a_split(self):
        self.assertEqual(reference_discontinuity(100, 52, 2), .5)
        self.assertEqual(reference_discontinuity(100, 94, 1), .93)
        self.assertIsNone(reference_discontinuity(100, 103.001, 3))


if __name__ == "__main__":
    unittest.main()
