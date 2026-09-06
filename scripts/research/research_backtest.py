"""사전 고정한 세 후보를 공시 시점과 다음 시가 체결로 진단하는 연구 전용 계산기."""
from dataclasses import asdict, dataclass
from datetime import date
import json
from pathlib import Path
import argparse

import numpy as np
import pandas as pd
from scipy.stats import rankdata


@dataclass(frozen=True)
class Parameters:
    family: str
    holdings: int = 40
    cash_buffer: float = 0.03
    cost_multiplier: float = 1.0
    seed: int = 0
    delay: int = 1
    min_cap: float = 50e9
    min_liquidity: float = 1e9
    horizons: tuple = (126, 189, 252)
    skip: int = 21
    absolute_momentum: bool = True
    market_filter: bool = False
    trend_windows: tuple = (150, 200, 250)


def metrics(equity, dates, rf_annual=None, initial=1e8):
    equity = np.asarray(equity, dtype=float)
    returns = equity / np.r_[initial,equity[:-1]] - 1
    rf = np.zeros(len(equity)) if rf_annual is None else np.asarray(rf_annual)
    excess = returns - ((1 + rf)**(1/252) - 1)
    std = np.std(excess,ddof=1)
    elapsed = (date.fromisoformat(str(dates[-1])) - date.fromisoformat(str(dates[0]))).days + 1
    wealth = equity[-1]/initial
    drawdown = equity / np.maximum.accumulate(np.r_[initial,equity])[1:] - 1
    return {'total_return_pct':100*(wealth-1),'cagr_pct':100*(wealth**(365.25/elapsed)-1),
            'sharpe':float(excess.mean()/std*np.sqrt(252)) if std else None,
            'sharpe_rf0':float(returns.mean()/returns.std(ddof=1)*np.sqrt(252)) if returns.std(ddof=1) else None,
            'mdd_pct':100*float(drawdown.min()),'volatility_pct':100*float(returns.std(ddof=1)*np.sqrt(252)),
            'from':str(dates[0]),'to':str(dates[-1]),'observations':len(equity)}


def percentile(values, mask):
    scores = np.full(len(values),np.nan)
    valid = mask & np.isfinite(values)
    if valid.any(): scores[valid] = rankdata(values[valid],method='average') / valid.sum()
    return scores


def sell_tax(day):
    rate = .003
    for start,value in [('2019-05-30',.0025),('2020-12-29',.0023),('2022-12-28',.002),
                        ('2023-12-27',.0018),('2024-12-27',.0015),('2025-12-29',.002)]:
        if day >= start: rate = value
    return rate


def tick_size(price, day, market):
    if day >= '2023-01-25':
        for threshold,tick in [(2000,1),(5000,5),(20000,10),(50000,50),(200000,100),(500000,500)]:
            if price < threshold: return tick
        return 1000
    for threshold,tick in [(1000,1),(5000,5),(10000,10),(50000,50)]:
        if price < threshold: return tick
    if price < 100000 or market == 2: return 100
    return 500 if price < 500000 else 1000


class Research:
    def __init__(self, root, annual, fred):
        self.root = Path(root)
        self.data = {p.stem:np.load(p,mmap_mode='r') for p in self.root.glob('*.npy')}
        self.days, self.codes = self.data['days'],self.data['codes']
        self.code_index = {str(c):i for i,c in enumerate(self.codes)}
        self.reports = json.loads(Path(annual).read_text())
        if not self.reports['complete']: raise ValueError('연간 재무 API 조회가 완료되지 않았습니다')
        self.financial_cache = {}
        self.market_index = []
        for market in ['KOSPI','KOSDAQ']:
            path = self.root.parent / f'{market}-reference.json'
            if path.exists():
                rows = [r.split('|') for r in json.loads(path.read_text())]
                series = pd.Series([float(r[4]) for r in rows],index=[f'{r[0][:4]}-{r[0][4:6]}-{r[0][6:8]}' for r in rows])
                self.market_index.append(series.reindex(self.days).to_numpy())
        self.macro = {}
        for line in Path(fred).read_text().splitlines():
            record = json.loads(line)
            rows = [r for r in record.get('observations',[]) if r['value'] != '.']
            self.macro[record['series']] = pd.Series([float(r['value']) for r in rows],index=[r['date'] for r in rows])
        # 단기 은행간 금리는 무위험 자산 자체가 아니므로 성과 비교의 대용치로만 사용한다.
        rates = self.macro['IR3TIB01KRM156N'].copy()
        rates.index = (pd.to_datetime(rates.index) + pd.DateOffset(months=2)).strftime('%Y-%m-%d')
        self.rf = rates.reindex(sorted(set(rates.index)|set(self.days))).ffill().reindex(self.days).to_numpy()/100
        self.rf = np.nan_to_num(self.rf,nan=.04)

    def financials(self, i):
        if i in self.financial_cache: return self.financial_cache[i]
        today = str(self.days[i])
        latest = {}
        for row in self.reports['observations']:
            if row['asof'] >= today: break
            age = (date.fromisoformat(today)-date.fromisoformat(row['asof'])).days
            if age > 540: continue
            j = self.code_index.get(row['code'])
            if j is None: continue
            old = latest.get(j)
            # 더 최신 사업연도가 우선이며 같은 연도는 현재 공개된 연결재무를 우선한다.
            key = (row['year'],row['basis']=='CFS',row['asof'])
            if old is None or key > old[0]: latest[j] = (key,row)
        operating,book = np.full(len(self.codes),np.nan),np.full(len(self.codes),np.nan)
        for j,(_,row) in latest.items(): operating[j],book[j] = row['operating_income'],row['equity']
        self.financial_cache[i] = operating,book
        return operating,book

    def targets(self, i, p, rng):
        d = self.data
        eligible = d['common'][i] & (d['liquidity'][i]>=p.min_liquidity) & (d['cap'][i]>=p.min_cap)
        eligible = eligible & (d['volume'][i]>0) & ~d['nontrading'][i] & np.isfinite(d['close'][i-max(p.horizons)])
        adjusted = d['reference_close']
        momenta = []
        with np.errstate(divide='ignore',invalid='ignore'):
            for horizon in p.horizons:
                momenta.append(adjusted[i-p.skip]/adjusted[i-horizon]-1)
        price_valid = eligible & np.all(np.isfinite(momenta),axis=0)
        if p.absolute_momentum:
            eligible = eligible & (np.mean(momenta,axis=0)>0)
            price_valid = price_valid & eligible
        price = np.mean([percentile(m,price_valid) for m in momenta],axis=0)
        operating,book = self.financials(i)
        financial_valid = eligible & (operating>0) & (book>0)
        with np.errstate(invalid='ignore',divide='ignore'):
            quality = (percentile(operating/d['cap'][i],financial_valid) + percentile(operating/book,financial_valid))/2
        score = price if p.family == 'momentum' else quality if p.family == 'quality' else (price+quality)/2
        valid = np.flatnonzero(np.isfinite(score))
        # 평균 백분위의 동률과 동시 매수 우선순위만 난수로 흔든다.
        ordered = valid[np.lexsort((rng.random(len(valid)),-score[valid]))]
        selected = ordered[:p.holdings]
        missing_reference = [str(self.codes[j]) for j in selected if not np.isfinite(adjusted[i,j])]
        if missing_reference: raise ValueError(f'선정 종목 독립 시세 누락: {missing_reference}')
        return selected, {'eligible':int(eligible.sum()),'price_available':int(price_valid.sum()),'financial_available':int(financial_valid.sum()),'financial_observed':int((eligible & np.isfinite(operating) & np.isfinite(book)).sum())}

    def run(self, p, start, end, initial=1e8):
        d = self.data
        first = int(np.searchsorted(self.days,start))
        stop = int(np.searchsorted(self.days,end,side='right'))
        if first < max(p.horizons) or stop <= first: raise ValueError('검증 기간 또는 워밍업이 부족합니다')
        rng = np.random.default_rng(p.seed)
        units = np.zeros(len(self.codes))
        cash, total_cost, turnover = initial, 0.,0.
        pending, due = None,None
        equity, trades, diagnostics, selections = [],[],[],[]
        last_raw = np.array(d['close'][first-1])
        previous_factor = np.array(d['reference_factor'][first-1])
        for i in range(first,stop):
            today = str(self.days[i])
            raw_close = np.array(d['close'][i])
            factors = np.array(d['reference_factor'][i])
            factors = np.where(np.isfinite(factors)&(factors>0),factors,previous_factor)
            raw_close = np.where(np.isfinite(raw_close)&(raw_close>0),raw_close,last_raw)
            held = np.flatnonzero(units>0)
            for j in held:
                if d['missing'][i,j]: diagnostics.append({'kind':'unknown_price_gap','date':today,'code':str(self.codes[j])})
                if not d['active'][i,j]:
                    # 마지막 가격에 미리 팔 수 있다고 가정하지 않고 상장 종료 시 회수를 0으로 둔다.
                    diagnostics.append({'kind':'terminal_zero_recovery','date':today,'code':str(self.codes[j])})
                    units[j] = 0
                elif not np.isfinite(factors[j]):
                    raise ValueError(f'보유 평가 보정계수 누락: {today} {self.codes[j]}')
                elif np.isfinite(previous_factor[j]) and abs(factors[j]/previous_factor[j]-1)>.01:
                    diagnostics.append({'kind':'reference_adjustment','date':today,'code':str(self.codes[j]),'ratio':float(factors[j]/previous_factor[j])})
            if pending is not None and i >= due:
                target = pending
                current = units*factors
                desired = np.floor(target*factors + 1e-8)
                delta = desired - np.floor(current+1e-8)
                sells = np.flatnonzero(delta < 0)
                buys = rng.permutation(np.flatnonzero(delta > 0))
                for side,indices in [('sell',sells),('buy',buys)]:
                    for j in indices:
                        opening = d['open'][i,j]
                        if not np.isfinite(opening) or opening<=0 or d['nontrading'][i,j]: continue
                        if side == 'buy' and not d['common'][i,j]: continue
                        # 시가 고정 상·하한가 봉에서는 불리한 쪽 주문 체결을 만들지 않는다.
                        if d['high'][i,j]==d['low'][i,j] and ((side=='buy' and opening>last_raw[j]) or (side=='sell' and opening<last_raw[j])): continue
                        participation = min(np.nan_to_num(d['volume'][i-1,j])*.01,np.nan_to_num(d['volume'][i,j]))
                        quantity = min(abs(delta[j]),np.floor(participation))
                        if quantity<=0: continue
                        slip = .0005*p.cost_multiplier
                        slipped = opening*(1+slip if side=='buy' else 1-slip)
                        tick = tick_size(slipped,today,int(d['market'][i,j]))
                        price = np.ceil(slipped/tick-1e-9)*tick if side=='buy' else np.floor(slipped/tick+1e-9)*tick
                        commission = .00015*p.cost_multiplier
                        if side=='buy': quantity = min(quantity,np.floor(cash/(price*(1+commission))))
                        if quantity<=0: continue
                        gross = quantity*price
                        fee = gross*commission
                        tax = np.floor(gross*sell_tax(today)) if side=='sell' else 0
                        if side=='sell':
                            cash += gross-fee-tax
                            units[j] = max(0,units[j]-quantity/factors[j])
                        else:
                            cash -= gross+fee
                            units[j] += quantity/factors[j]
                        cost = fee+tax+quantity*abs(price-opening)
                        total_cost += cost
                        turnover += gross
                        trades.append({'date':today,'code':str(self.codes[j]),'side':side,'quantity':float(quantity),'price':float(price),'cost':float(cost)})
                pending = None
            value = cash + np.nansum(units*factors*raw_close)
            if cash < -1e-4 or not np.isfinite(value) or value<=0: raise ValueError('현금 또는 평가금액 오류')
            equity.append(float(value))
            is_signal = i==first or (i+1 < len(self.days) and today[:7]!=str(self.days[i+1])[:7])
            if is_signal and i+p.delay < stop:
                selected,coverage = self.targets(i,p,rng)
                pending = np.zeros(len(self.codes))
                exposure = 1.
                if p.market_filter:
                    if len(self.market_index)!=2: raise ValueError('시장 추세 필터에 필요한 두 지수가 없습니다')
                    votes = [float(series[i] > np.mean(series[i-window+1:i+1])) for series in self.market_index for window in p.trend_windows]
                    exposure = float(np.mean(votes))
                coverage['exposure'] = exposure
                per_stock = value*(1-p.cash_buffer)*exposure/p.holdings
                pending[selected] = np.floor(per_stock/raw_close[selected])/factors[selected]
                due = i+p.delay
                selections.append({'date':today,'codes':[str(self.codes[j]) for j in selected],**coverage})
            previous_factor = factors
            last_raw = raw_close
        dates = self.days[first:stop]
        result = metrics(equity,dates,self.rf[first:stop],initial)
        result['cagr_pct'] = 100*((equity[-1]/initial)**(365.25/((date.fromisoformat(end)-date.fromisoformat(start)).days+1))-1)
        result.update({'requested_from':start,'requested_to':end,'parameters':asdict(p),'total_cost':float(total_cost),'traded_notional':float(turnover),
                       'trade_count':len(trades),'diagnostic_counts':dict(pd.Series([x['kind'] for x in diagnostics],dtype=str).value_counts().items()),
                       'status':'DIAGNOSTIC_ONLY_REFERENCE_ADJUSTMENTS_NOT_CERTIFIED'})
        return result, {'equity':equity,'dates':dates.tolist(),'trades':trades,'diagnostics':diagnostics,'selections':selections}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--start',required=True)
    parser.add_argument('--end',required=True)
    parser.add_argument('--family',choices=['momentum','quality','combined'],required=True)
    parser.add_argument('--holdings',type=int,default=40)
    parser.add_argument('--market-filter',action='store_true')
    args = parser.parse_args()
    base,output = Path(args.data),Path(args.output)
    if output.exists():
        raise FileExistsError('기존 실험을 덮어쓰지 않습니다')
    research = Research(base/'panel',base/'annual.json',base/'fred.jsonl')
    params = Parameters(family=args.family,holdings=args.holdings,market_filter=args.market_filter)
    result,details = research.run(params,args.start,args.end)
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x') as stream:
        json.dump({'result':result,**details},stream,ensure_ascii=False)
    print(json.dumps(result,ensure_ascii=False))
