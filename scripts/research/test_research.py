"""연구 계산에서 정보 시점, 분할, 다음 시가, 비용 및 낙폭 정의를 검증한다."""
import unittest
import numpy as np

from research_backtest import Parameters, Research, metrics


def synthetic():
    research = Research.__new__(Research)
    research.root = None
    research.days = np.arange('2020-01-01','2020-12-31',dtype='datetime64[D]').astype(str)
    research.codes = np.array(['000001','000002'])
    research.code_index = {'000001':0,'000002':1}
    shape = (len(research.days),2)
    close = np.tile(np.linspace(50,100,len(research.days))[:,None],(1,2))
    research.data = {'close':close,'open':close.copy(),'high':close+2,'low':close-2,
        'volume':np.full(shape,1e8),'cap':np.full(shape,1e12),'liquidity':np.full(shape,1e10),
        'common':np.ones(shape,dtype=bool),'active':np.ones(shape,dtype=bool),
        'nontrading':np.zeros(shape,dtype=bool),'missing':np.zeros(shape,dtype=bool),
        'market':np.ones(shape,dtype=np.int8),'reference_close':close.copy(),'reference_factor':np.ones(shape)}
    research.rf = np.full(len(research.days),.03)
    research.financial_cache = {}
    research.reports = {'complete':True,'observations':[]}
    return research


class ResearchTests(unittest.TestCase):
    def test_drawdown_includes_initial_capital(self):
        result = metrics([90,100],['2020-01-01','2020-01-02'],initial=100)
        self.assertAlmostEqual(result['mdd_pct'],-10)

    def test_risk_free_rate_reduces_sharpe(self):
        series = [101,100,102,103]
        dates = ['2020-01-01','2020-01-02','2020-01-03','2020-01-04']
        low = metrics(series,dates,np.zeros(4),initial=100)
        high = metrics(series,dates,np.full(4,.05),initial=100)
        self.assertLess(high['sharpe'],low['sharpe'])

    def test_filing_is_unavailable_on_receipt_day(self):
        research = synthetic()
        research.reports['observations'] = [{'code':'000001','year':2019,'basis':'CFS','asof':'2020-09-01','operating_income':10,'equity':20}]
        i = np.searchsorted(research.days,'2020-09-01')
        self.assertTrue(np.isnan(research.financials(i)[0][0]))
        self.assertEqual(research.financials(i+1)[0][0],10)

    def test_older_restatement_does_not_replace_newer_year(self):
        research = synthetic()
        research.reports['observations'] = [
            {'code':'000001','year':2019,'basis':'CFS','asof':'2020-03-01','operating_income':10,'equity':20},
            {'code':'000001','year':2018,'basis':'CFS','asof':'2020-08-01','operating_income':1000,'equity':20}]
        self.assertEqual(research.financials(270)[0][0],10)

    def test_future_prices_do_not_change_targets(self):
        research = synthetic()
        params = Parameters('momentum',holdings=1)
        first,_ = research.targets(270,params,np.random.default_rng(0))
        research.data['reference_close'][271:,0] *= 100
        second,_ = research.targets(270,params,np.random.default_rng(0))
        np.testing.assert_array_equal(first,second)

    def test_next_open_execution_and_costs(self):
        research = synthetic()
        params = Parameters('momentum',holdings=2)
        result,details = research.run(params,'2020-09-28','2020-09-29')
        self.assertTrue(details['trades'])
        self.assertTrue(all(t['date']=='2020-09-29' for t in details['trades']))
        self.assertGreater(result['total_cost'],0)
        self.assertEqual(details['equity'][0],1e8)

    def test_split_keeps_economic_position_value(self):
        research = synthetic()
        params = Parameters('momentum',holdings=2)
        _,base = research.run(params,'2020-09-28','2020-10-05')
        split = np.searchsorted(research.days,'2020-10-02')
        for key in ['close','open','high','low']:
            research.data[key][split:] /= 2
        research.data['reference_factor'][split:] = 2
        _,adjusted = research.run(params,'2020-09-28','2020-10-05')
        np.testing.assert_allclose(base['equity'],adjusted['equity'],atol=.001)

    def test_delisting_does_not_sell_at_future_known_last_close(self):
        research = synthetic()
        end = np.searchsorted(research.days,'2020-10-02')
        research.data['active'][end:,0] = False
        _,details = research.run(Parameters('momentum',holdings=2),'2020-09-28','2020-10-05')
        self.assertTrue(any(d['kind']=='terminal_zero_recovery' for d in details['diagnostics']))
        self.assertLess(details['equity'][-1],7e7)


if __name__=='__main__': unittest.main()
