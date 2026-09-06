"""배당 권리·지급 현금·분할 단위와 공식 수익률 대조의 실패 조건을 검증한다."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
import numpy as np

from cash_distributions import CashDistributions, PROVISIONAL
from diversified_backtest import DiversifiedParameters
from distribution_reconciliation import issuer_ten_year, exact_index, replay_distributions
from test_diversified import synthetic


def scenario(ex='2012-01-03',pay='2012-01-05',amount=10.):
    return {'status':PROVISIONAL,'coverage_from':'2012-01-01','coverage_to':'2012-12-31',
            'covered_symbols':['QLD','GLD'],'amount_unit':'USD_PER_ACTUAL_EX_DATE_SHARE',
            'events':[{'symbol':'QLD','ex_date':ex,'pay_date':pay,'amount_usd':amount,'source_refs':['synthetic']} ]}


class DistributionTests(unittest.TestCase):
    def test_new_ex_day_buyers_have_no_entitlement(self):
        r=synthetic(); data=scenario(ex='2012-01-02')
        result=r.run(DiversifiedParameters(cost_multiplier=0),'2012-01-02','2012-01-05',distribution_scenario=data)
        self.assertTrue(result['trades'])
        self.assertEqual(result['summary']['distribution_audit']['accrued_usd'],0)
        replay_distributions(r,result,data)

    def test_receivable_prevents_artificial_ex_day_loss(self):
        r=synthetic(); data=scenario()
        i=np.searchsorted(r.days,'2012-01-03')
        for key in ['open','high','low','close']:
            r.data[key][i:,0]-=10
        result=r.run(DiversifiedParameters(cost_multiplier=0),'2012-01-02','2012-01-05',distribution_scenario=data)
        np.testing.assert_allclose(result['equity'],100000,atol=1e-7)
        audit=result['summary']['distribution_audit']
        self.assertEqual(audit['paid_usd'],3960)
        self.assertEqual(audit['entries'][0]['cash_posted_date'],'2012-01-05')
        replay_distributions(r,result,data)

    def test_split_after_entitlement_does_not_multiply_receivable(self):
        r=synthetic(); data=scenario()
        i=np.searchsorted(r.days,'2012-01-04');r.data['split'][i,0]=2
        for key in ['open','high','low','close']:
            r.data[key][i:,0]/=2
        result=r.run(DiversifiedParameters(cost_multiplier=0),'2012-01-02','2012-01-05',distribution_scenario=data)
        self.assertEqual(result['summary']['distribution_audit']['paid_usd'],3960)
        replay_distributions(r,result,data)

    def test_ex_day_sellers_keep_their_entitlement(self):
        r=synthetic(); data=scenario(ex='2012-02-01',pay='2012-02-06')
        i=np.searchsorted(r.days,'2012-01-31')
        for key in ['open','high','low','close']:
            r.data[key][i:,0]*=2
        result=r.run(DiversifiedParameters(cost_multiplier=0),'2012-01-02','2012-02-06',distribution_scenario=data)
        sells=[t for t in result['trades'] if t['date']=='2012-02-01' and t['symbol']=='QLD' and t['side']=='sell']
        self.assertTrue(sells)
        self.assertEqual(result['summary']['distribution_audit']['entries'][0]['entitled_shares'],396)
        replay_distributions(r,result,data)

    def test_payment_on_next_month_open_cannot_fund_that_order(self):
        r=synthetic(); p=DiversifiedParameters(cost_multiplier=0)
        a=scenario(ex='2012-01-31',pay='2012-02-01',amount=1000)
        b=scenario(ex='2012-01-31',pay='2012-02-02',amount=1000)
        first=r.run(p,'2012-01-02','2012-02-02',distribution_scenario=a)
        later=r.run(p,'2012-01-02','2012-02-02',distribution_scenario=b)
        self.assertEqual(first['trades'],later['trades'])
        self.assertIn('partial_fill',first['summary']['diagnostic_counts'])
        replay_distributions(r,first,a);replay_distributions(r,later,b)

    def test_weekend_payment_posts_on_next_session(self):
        r=synthetic();data=scenario(pay='2012-01-07')
        result=r.run(DiversifiedParameters(),'2012-01-02','2012-01-09',distribution_scenario=data)
        self.assertEqual(result['summary']['distribution_audit']['entries'][0]['cash_posted_date'],'2012-01-09')
        replay_distributions(r,result,data)

    def test_unpaid_claim_remains_in_equity_at_end(self):
        r=synthetic();data=scenario(pay='2012-01-09')
        result=r.run(DiversifiedParameters(),'2012-01-02','2012-01-05',distribution_scenario=data)
        audit=result['summary']['distribution_audit']
        self.assertEqual(audit['paid_usd'],0)
        self.assertEqual(audit['ending_receivable_usd'],3960)
        replay_distributions(r,result,data)

    def test_duplicate_invalid_currency_and_missing_coverage_are_rejected(self):
        r=synthetic()
        changes=[lambda s:s['events'].append(dict(s['events'][0])),
                 lambda s:s.update(amount_unit='USD_PER_CURRENT_ADJUSTED_SHARE'),
                 lambda s:s.update(coverage_to='2012-01-03'),
                 lambda s:s['events'][0].update(amount_usd=float('nan')),
                 lambda s:s['events'][0].update(pay_date='2012-01-02'),
                 lambda s:s.update(status='CERTIFIED'),
                 lambda s:s['events'][0].update(ex_date='2012-01-07')]
        for change in changes:
            data=deepcopy(scenario());change(data)
            with self.subTest(data=data),self.assertRaises(ValueError):
                CashDistributions(data,r.days,r.symbols,'2012-01-02','2012-01-05')

    def test_observed_quote_bound_includes_open_below_stated_low_for_sell(self):
        r=synthetic();i=np.searchsorted(r.days,'2012-02-01')
        for key in ['open','high','low','close']:
            r.data[key][i-1:,1]*=2
        r.data['open'][i,1]=80.;r.data['valid_open'][i,1]=False
        result=r.run(DiversifiedParameters(invalid_open_policy='quote_worst'),'2012-01-02','2012-02-02')
        trade=next(t for t in result['trades'] if t['date']=='2012-02-01' and t['symbol']=='GLD')
        self.assertEqual(trade['side'],'sell')
        self.assertLess(trade['price'],80.)
        self.assertIn('invalid_open_worst_observed_quote_bound',result['summary']['diagnostic_counts'])

    def test_reconciliation_rejects_missing_endpoint_and_changed_issuer_date(self):
        with self.assertRaisesRegex(ValueError,'기준일 누락'):
            exact_index(np.array(['2023-12-28']),'2023-12-29')
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'performance.csv'
            path.write_text('Fund Symbol,Return Type,Data Period,Return Effective Date,10-Year Return\nQLD,NAV,MONTH,2026-09-30 00:00:00.000,33.21\n')
            with self.assertRaisesRegex(ValueError,'기준일'):
                issuer_ten_year(path)


if __name__=='__main__':
    unittest.main()
