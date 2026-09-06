"""분산 ETF 계산의 분할·정보 시점·체결 제약과 위험 상한을 검증한다."""
from dataclasses import replace
import unittest
import json
from pathlib import Path
import tempfile
import numpy as np
import pandas as pd
from diversified_backtest import DiversifiedResearch,DiversifiedParameters
from diversified_validation import initial_dollars, benchmark, asof, load_issuer
from trend_diversified import TrendDiversifiedResearch


def synthetic():
    r = DiversifiedResearch.__new__(DiversifiedResearch)
    r.days = pd.bdate_range('2010-01-01','2013-12-31').strftime('%Y-%m-%d').to_numpy(dtype=str)
    r.symbols = np.array(['QLD','GLD']); n = len(r.days)
    close = np.tile([100.,50.],(n,1))
    r.data = {'close':close,'signal_close':close.copy(),'open':close.copy(),'high':close+1,'low':close-1,
              'volume':np.full((n,2),1e7),'valid_open':np.ones((n,2),dtype=bool),'split':np.ones((n,2))}
    r.returns = np.column_stack([.01*np.sin(np.arange(n)),.015*np.cos(np.arange(n))])
    r.rf = np.full(n,.03); r.audit = {'source_hashes':{}}
    return r


class DiversifiedTests(unittest.TestCase):
    def test_future_returns_do_not_change_current_risk_weights(self):
        r = synthetic(); p = DiversifiedParameters('risk_parity_capped'); i = 600
        before = r.weights(i,p)
        r.returns[i+1:] *= 100
        np.testing.assert_allclose(before,r.weights(i,p),rtol=0,atol=0)

    def test_cap_reduces_high_volatility_exposure_without_borrowing(self):
        r = synthetic(); r.returns *= 10
        p = DiversifiedParameters('fixed_mix_capped')
        weights = r.weights(600,p)
        self.assertLess(weights.sum(),.99)
        self.assertAlmostEqual(weights[0]/weights[1],.4/.6)
        self.assertTrue((weights>=0).all())

    def test_split_preserves_wealth_and_pending_order_units(self):
        r = synthetic(); p = DiversifiedParameters(cost_multiplier=0)
        before = r.run(p,'2012-05-30','2012-06-05')
        i = np.searchsorted(r.days,'2012-06-01')
        r.data['split'][i,0] = 2
        for key in ['open','high','low','close']:
            r.data[key][i:,0] /= 2
        after = r.run(p,'2012-05-30','2012-06-05')
        np.testing.assert_allclose(before['equity'],after['equity'],atol=1e-7)
        self.assertEqual(after['summary']['diagnostic_counts']['share_split'],1)

    def test_insufficient_volume_does_not_create_fills(self):
        r = synthetic(); r.data['volume'][:] = 1
        result = r.run(DiversifiedParameters(),'2012-01-02','2012-01-05')
        self.assertEqual(result['trades'],[])
        self.assertEqual(result['equity'],[100000]*4)
        self.assertEqual(result['summary']['diagnostic_counts']['partial_fill'],2)

    def test_opening_gap_never_creates_negative_cash(self):
        r = synthetic(); r.data['open'][:] *= 2; r.data['high'][:] *= 3
        result = r.run(DiversifiedParameters(),'2012-01-02','2012-01-05')
        spent = sum(t['quantity']*t['price']+t['commission'] for t in result['trades'])
        self.assertLessEqual(spent,100000)
        self.assertIn('partial_fill',result['summary']['diagnostic_counts'])

    def test_bad_quote_boundary_is_explicit_and_adverse(self):
        r = synthetic(); i = np.searchsorted(r.days,'2012-01-02'); r.data['valid_open'][i,1] = False
        p = DiversifiedParameters()
        with self.assertRaisesRegex(ValueError,'주문 시가 오류'):
            r.run(p,'2012-01-02','2012-01-05')
        result = r.run(replace(p,invalid_open_policy='range_worst'),'2012-01-02','2012-01-05')
        trade = next(t for t in result['trades'] if t['symbol']=='GLD')
        self.assertGreater(trade['price'],r.data['high'][i,1])
        self.assertIn('invalid_open_worst_bar_bound',result['summary']['diagnostic_counts'])

    def test_minimum_commission_does_not_borrow_for_small_account(self):
        r = synthetic()
        result = r.run(DiversifiedParameters(), '2012-01-02', '2012-01-05', initial=210.)
        self.assertTrue(result['trades'])
        self.assertTrue(all(t['commission'] >= 1 for t in result['trades']))
        spent = sum(t['quantity']*t['price']+t['commission'] for t in result['trades'])
        self.assertLessEqual(spent, 210.)

    def test_initial_fx_uses_previous_session_and_not_entry_day_close(self):
        r = synthetic()
        r.macro = {'DEXKOUS':pd.Series([1000., 2000.], index=['2011-12-30','2012-01-02'])}
        dollars, fx = initial_dollars(r, '2012-01-02', capital=100000., spread=0)
        self.assertEqual(fx, 1000.)
        self.assertEqual(dollars, 100.)
        r.macro['DEXKOUS'].iloc[-1] = 9000.
        self.assertEqual(initial_dollars(r, '2012-01-02', 100000., 0), (100.,1000.))

    def test_asof_never_backfills_a_future_observation(self):
        values = pd.Series([1000., 2000.], index=['2012-01-02','2012-01-04'])
        self.assertEqual(asof(values, ['2012-01-03']).tolist(), [1000.])
        with self.assertRaisesRegex(ValueError, '관측값 누락'):
            asof(values, ['2012-01-01'])

    def test_benchmark_starts_before_the_first_market_session(self):
        r = synthetic()
        r.macro = {'NASDAQ100':pd.Series([100., 120., 130.],index=['2011-12-30','2012-01-02','2012-01-03']),
                   'DEXKOUS':pd.Series([1000.],index=['2011-12-30']),
                   'IR3TIB01KRM156N':pd.Series([3.],index=['2011-10-01'])}
        result = r.run(DiversifiedParameters(), '2012-01-02', '2012-01-03', initial=100000.)
        comparison = benchmark(r, result)
        self.assertAlmostEqual(comparison['usd']['total_return_pct'], 30.)

    def test_issuer_comparison_rejects_a_new_reference_date(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'issuer.json'
            path.write_text(json.dumps({'effectiveDate':'2026-09-30','ticker':'QQQ','currencyCode':'USD'}))
            with self.assertRaisesRegex(ValueError, '기준일'):
                load_issuer(path)

    def test_trend_votes_reduce_only_the_falling_asset(self):
        r = synthetic()
        r.__class__ = TrendDiversifiedResearch
        r.trend_prices = np.column_stack([np.arange(len(r.days))+100., 3000.-np.arange(len(r.days))])
        p = DiversifiedParameters(family='trend_mix')
        np.testing.assert_allclose(r.weights(600,p), [.396,0.])
        before = r.weights(600,p)
        r.trend_prices[601:] *= 100
        np.testing.assert_allclose(r.weights(600,p), before)

    def test_execution_noise_reproduces_for_same_seed(self):
        r = synthetic(); p = DiversifiedParameters(random_execution=True,seed=42)
        first = r.run(p,'2012-01-02','2012-12-31')
        second = r.run(p,'2012-01-02','2012-12-31')
        self.assertEqual(first['equity'],second['equity'])
        self.assertEqual(first['trades'],second['trades'])


if __name__=='__main__':
    unittest.main()
