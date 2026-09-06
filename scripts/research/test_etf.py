"""ETF 연구의 정보 시점, 주문 제약과 입력 오류 차단을 검증한다."""
from dataclasses import replace
import unittest

import numpy as np
import pandas as pd

from etf_backtest import ETFParameters, ETFResearch


def synthetic():
    r = ETFResearch.__new__(ETFResearch)
    r.days = pd.bdate_range('2010-01-01','2013-12-31').strftime('%Y-%m-%d').to_numpy()
    r.close = np.column_stack([np.linspace(50,120,len(r.days)),np.full(len(r.days),50.)])
    r.open = r.close.copy()
    r.valid_open = np.ones_like(r.open,dtype=bool)
    r.rf = np.full(len(r.days),.03)
    r.symbols = ['QQQ','GLD']
    r.sources, r.audit = [], []
    return r


class ETFTests(unittest.TestCase):
    def test_future_quotes_do_not_change_signal_or_previous_results(self):
        r = synthetic()
        p = ETFParameters('qqq_gold')
        i = np.searchsorted(r.days,'2012-03-01')
        signal = r.weights(i,p)
        prior = r.run(p,'2012-01-01','2012-03-01')
        r.close[i+1:] *= .1
        r.open[i+1:] *= 10
        np.testing.assert_allclose(signal,r.weights(i,p))
        np.testing.assert_allclose(prior['equity'],r.run(p,'2012-01-01','2012-03-01')['equity'])

    def test_initial_order_uses_previous_close_and_subsequent_open(self):
        r = synthetic()
        p = ETFParameters('buy_hold')
        i = np.searchsorted(r.days,'2012-01-02')
        r.open[i,0] *= 1.1
        result = r.run(p,'2012-01-02','2012-01-05')
        trade = result['trades'][0]
        self.assertEqual(trade['date'],'2012-01-02')
        self.assertAlmostEqual(trade['price'],r.open[i,0]*1.0005)
        self.assertLessEqual(trade['quantity'],np.floor(100000*.99/r.close[i-1,0]))
        self.assertLessEqual(trade['quantity']*trade['price']*1.0001,100000)

    def test_delay_changes_execution_date(self):
        r = synthetic()
        result = r.run(ETFParameters('buy_hold',delay=3),'2012-01-02','2012-01-10')
        self.assertEqual(result['trades'][0]['date'],'2012-01-04')
        self.assertEqual(result['equity'][:2],[100000,100000])

    def test_invalid_open_blocks_only_orders_using_that_quote(self):
        r = synthetic()
        i = np.searchsorted(r.days,'2012-01-02')
        r.valid_open[i,1] = False
        r.run(ETFParameters('buy_hold'),'2012-01-02','2012-01-05')
        r.valid_open[i,0] = False
        with self.assertRaisesRegex(ValueError,'시가 검증 실패'):
            r.run(ETFParameters('buy_hold'),'2012-01-02','2012-01-05')

    def test_single_asset_seed_is_exactly_irrelevant_without_execution_noise(self):
        r = synthetic()
        base = r.run(ETFParameters('qqq_trend'),'2012-01-02','2012-12-31')
        other = r.run(ETFParameters('qqq_trend',seed=999),'2012-01-02','2012-12-31')
        self.assertEqual(base['equity'],other['equity'])

    def test_flat_price_costs_lower_terminal_wealth(self):
        r = synthetic()
        r.close[:],r.open[:] = 100.,100.
        p = ETFParameters('buy_hold')
        base = r.run(p,'2012-01-02','2012-03-01')
        expensive = r.run(replace(p,cost_multiplier=4),'2012-01-02','2012-03-01')
        self.assertLess(expensive['equity'][-1],base['equity'][-1])


if __name__=='__main__':
    unittest.main()
