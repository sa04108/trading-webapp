"""공식 분할·정수 수량·다음 시가를 적용한 주식·금 포트폴리오 연구 계산기."""
import argparse
from dataclasses import asdict, dataclass
from datetime import date
import json
from pathlib import Path

import numpy as np
import pandas as pd
from research_backtest import metrics
from cash_distributions import CashDistributions


@dataclass(frozen=True)
class DiversifiedParameters:
    family: str = 'fixed_mix'
    equity_weight: float = .4
    window_scale: float = 1.
    volatility_cap: float = .2
    cash_buffer: float = .01
    delay: int = 1
    cost_multiplier: float = 1.
    seed: int = 0
    minimum_commission_usd: float = 1.
    commission_per_share: float = .005
    sell_fee_rate: float = .0001
    signal_offset: int = 0
    rebalance_months: int = 1
    random_execution: bool = False
    invalid_open_policy: str = 'fail'


class DiversifiedResearch:
    def __init__(self, root, fred):
        self.root = Path(root)
        self.data = {p.stem:np.load(p,allow_pickle=False) for p in self.root.glob('*.npy')}
        self.days, self.symbols = self.data['days'], self.data['symbols']
        self.audit = json.loads((self.root/'audit.json').read_text())
        self.macro = {}
        for line in Path(fred).read_text().splitlines():
            row = json.loads(line)
            obs = [x for x in row.get('observations',[]) if x['value']!='.']
            self.macro[row['series']] = pd.Series([float(x['value']) for x in obs],index=[x['date'] for x in obs],dtype=float)
        rates = self.macro['DTB3']
        self.rf = rates.reindex(sorted(set(rates.index)|set(self.days))).ffill().reindex(self.days).shift(1).fillna(0).to_numpy()/100
        self.returns = np.vstack([np.zeros(2),self.data['signal_close'][1:]/self.data['signal_close'][:-1]-1])

    def weights(self, i, p):
        if p.family in ['fixed_mix','equity_only','gold_only']:
            q = p.equity_weight if p.family=='fixed_mix' else 1. if p.family=='equity_only' else 0.
            return np.array([q,1-q])*(1-p.cash_buffer)
        windows = [round(x*p.window_scale) for x in [63,126,252]]
        if i<max(windows) or min(windows)<2:
            raise ValueError('위험 추정의 과거 이력이 부족합니다')
        inverse, covariances = [], []
        for window in windows:
            sample = self.returns[i-window+1:i+1]
            std = sample.std(axis=0,ddof=1)*np.sqrt(252)
            inv = 1/np.maximum(std,1e-6)
            inverse.append(inv/inv.sum())
            covariances.append(np.cov(sample,rowvar=False)*252)
        weights = np.array([p.equity_weight,1-p.equity_weight]) if p.family=='fixed_mix_capped' else np.mean(inverse,axis=0)
        if p.family in ['risk_parity_capped','fixed_mix_capped']:
            risk = np.sqrt(weights@np.mean(covariances,axis=0)@weights)
            weights *= min(1.,p.volatility_cap/max(risk,1e-6))
        elif p.family!='risk_parity':
            raise ValueError('알 수 없는 위험 배분 가족')
        return weights*(1-p.cash_buffer)

    def run(self,p,start,end,initial=100000.,distribution_scenario=None):
        if p.delay<1 or not 0<=p.cash_buffer<1 or not 0<=p.equity_weight<=1 or p.cost_multiplier<0 or p.rebalance_months<1 or p.window_scale<=0 or p.volatility_cap<=0 or p.minimum_commission_usd<0 or p.commission_per_share<0 or p.sell_fee_rate<0:
            raise ValueError('잘못된 체결·전략 매개변수')
        first = int(np.searchsorted(self.days,start)); stop = int(np.searchsorted(self.days,end,side='right'))
        if first<=round(252*p.window_scale) or stop<=first:
            raise ValueError('기간 또는 준비 이력이 부족합니다')
        d = self.data
        distributions = CashDistributions(distribution_scenario,self.days,self.symbols,start,end) if distribution_scenario is not None else None
        rng = np.random.default_rng(p.seed)
        cash, shares, total_cost = initial,np.zeros(2),0.
        pending = np.floor(initial*self.weights(first-1,p)/d['close'][first-1])
        due = first+p.delay-1
        month_ends = [i for i in range(first-1,stop) if i+1<len(self.days) and self.days[i][:7]!=self.days[i+1][:7]
                      and int(self.days[i][5:7])%p.rebalance_months==0]
        signals = {i+p.signal_offset for i in month_ends if first<=i+p.signal_offset<stop}
        equity, positions, trades, diagnostics, selections = [],[],[],[],[]
        for i in range(first,stop):
            today = str(self.days[i])
            if np.any(d['split'][i]!=1):
                shares *= d['split'][i]
                if pending is not None:
                    pending *= d['split'][i]
                diagnostics.append({'date':today,'kind':'share_split','ratios':d['split'][i].tolist()})
            if distributions is not None:
                distributions.accrue_before_orders(today,shares)
            if pending is not None and i>=due:
                delta = pending-shares
                order = list(np.flatnonzero(delta<0))+list(rng.permutation(np.flatnonzero(delta>0)))
                for j in order:
                    side = 'buy' if delta[j]>0 else 'sell'
                    opening = d['open'][i,j]
                    if not d['valid_open'][i,j]:
                        if p.invalid_open_policy not in ['range_worst','quote_worst']:
                            raise ValueError(f'주문 시가 오류: {today} {self.symbols[j]}')
                        # 오류 봉의 전체 범위에서 불리한 가격을 쓰는 별도 경계 실험이며 실제 시가가 아니다.
                        opening = d['high'][i,j] if side=='buy' else d['low'][i,j]
                        kind = 'invalid_open_worst_bar_bound'
                        if p.invalid_open_policy=='quote_worst':
                            # 어느 필드가 오류인지 미확정이므로 공급된 시가도 불리한 경계 후보에 포함한다.
                            quotes = [d[key][i,j] for key in ['open','high','low','close']]
                            opening = max(quotes) if side=='buy' else min(quotes)
                            kind = 'invalid_open_worst_observed_quote_bound'
                        diagnostics.append({'date':today,'kind':kind,'symbol':str(self.symbols[j])})
                    participation = np.floor(min(d['volume'][i-1,j]*.01,d['volume'][i,j]))
                    quantity = min(abs(delta[j]),participation)
                    slip = .0005*p.cost_multiplier*(rng.uniform(.5,1.5) if p.random_execution else 1.)
                    commission = .0001*p.cost_multiplier
                    minimum_fee = p.minimum_commission_usd*p.cost_multiplier
                    share_fee = p.commission_per_share*p.cost_multiplier
                    price = opening*(1+slip if side=='buy' else 1-slip)
                    price = np.ceil(price*100-1e-9)/100 if side=='buy' else np.floor(price*100+1e-9)/100
                    if side=='buy':
                        quantity = max(0,min(quantity,np.floor(max(cash,0)/(price*(1+commission))),
                                             np.floor(max(cash-minimum_fee,0)/price),np.floor(max(cash,0)/(price+share_fee))))
                    if quantity<abs(delta[j]):
                        diagnostics.append({'date':today,'kind':'partial_fill','symbol':str(self.symbols[j]),'requested':float(abs(delta[j])),'filled':float(quantity)})
                    if quantity<=0:
                        continue
                    gross = quantity*price
                    fee = max(gross*commission,minimum_fee,quantity*share_fee)
                    if side=='sell':
                        fee += gross*p.sell_fee_rate*p.cost_multiplier
                    cost = fee+quantity*abs(price-opening)
                    sign = 1 if side=='buy' else -1
                    cash -= sign*gross+fee
                    shares[j] += sign*quantity
                    total_cost += cost
                    trades.append({'date':today,'symbol':str(self.symbols[j]),'side':side,'quantity':int(quantity),'price':float(price),'commission':float(fee),'cost':float(cost)})
                pending = None
            receivable = 0.
            if distributions is not None:
                cash += distributions.settle_after_orders(today)
                receivable = distributions.receivable
            value = cash+shares@d['close'][i]+receivable
            if cash<-.00001 or np.any(shares<0) or not np.isfinite(value) or value<=0:
                raise ValueError('현금·정수 수량·평가금액 제약 위반')
            equity.append(float(value))
            positions.append((shares*d['close'][i]/value).tolist())
            if i in signals:
                weights = self.weights(i,p)
                pending = np.floor(value*weights/d['close'][i])
                due = i+(int(rng.integers(1,4)) if p.random_execution else p.delay)
                selections.append({'date':today,'weights':weights.tolist(),'shares':pending.tolist()})
        summary = metrics(equity,self.days[first:stop],self.rf[first:stop],initial)
        summary['cagr_pct'] = 100*((equity[-1]/initial)**(365.25/(date.fromisoformat(end)-date.fromisoformat(start)).days)-1)
        summary.update({'requested_from':start,'requested_to':end,'parameters':asdict(p),'initial_usd':initial,'total_cost_usd':total_cost,
                        'trade_count':len(trades),'status':'LEVERAGED_ETF_PRICE_ONLY_RETROSPECTIVE_NOT_FRESH_HOLDOUT',
                        'diagnostic_counts':pd.Series([x['kind'] for x in diagnostics],dtype=str).value_counts().to_dict()})
        if distributions is not None:
            summary['status'] = 'LEVERAGED_ETF_PROVISIONAL_DISTRIBUTIONS_RETROSPECTIVE_NOT_FRESH_HOLDOUT'
            summary['distribution_audit'] = distributions.report()
        return {'summary':summary,'dates':self.days[first:stop].tolist(),'equity':equity,'weights':positions,
                'trades':trades,'diagnostics':diagnostics,'selections':selections,'source_hashes':self.audit['source_hashes']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--panel',required=True)
    parser.add_argument('--fred',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--start',required=True)
    parser.add_argument('--end',required=True)
    parser.add_argument('--family',choices=['fixed_mix','fixed_mix_capped','risk_parity','risk_parity_capped','equity_only','gold_only'],required=True)
    parser.add_argument('--equity-weight',type=float,default=.4)
    parser.add_argument('--window-scale',type=float,default=1.)
    args = parser.parse_args(); output = Path(args.output)
    if output.exists():
        raise FileExistsError('기존 분산 전략 실험을 덮어쓰지 않습니다')
    r = DiversifiedResearch(args.panel,args.fred)
    result = r.run(DiversifiedParameters(args.family,equity_weight=args.equity_weight,window_scale=args.window_scale),args.start,args.end)
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x') as stream:
        json.dump(result,stream,ensure_ascii=False)
    print(json.dumps(result['summary'],ensure_ascii=False))


if __name__=='__main__':
    main()
