"""미국 일반 ETF의 시점 일치 신호·다음 시가 체결과 보수적 가격수익을 계산한다."""
import argparse
from dataclasses import asdict, dataclass
from datetime import date
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from research_backtest import metrics


@dataclass(frozen=True)
class ETFParameters:
    family: str = 'qqq_gold'
    window_scale: float = 1.0
    cash_buffer: float = .01
    delay: int = 1
    cost_multiplier: float = 1.0
    seed: int = 0
    signal_offset: int = 0
    random_delay: bool = False
    random_slippage: bool = False


class ETFResearch:
    def __init__(self, root, fred):
        root = Path(root)
        self.symbols = ['QQQ', 'GLD']
        series = []
        self.sources = []
        for ticker in ['QQQ.O', 'GLD']:
            records = {}
            for path in sorted(root.glob(ticker+'-*.json')):
                raw = path.read_bytes()
                self.sources.append({'file':path.name, 'sha256':hashlib.sha256(raw).hexdigest()})
                for row in json.loads(raw):
                    day = row['localDate']
                    values = [float(row[k]) for k in ['openPrice','highPrice','lowPrice','closePrice']]
                    if day in records and values != records[day]:
                        raise ValueError(f'중첩 기간 가격 충돌: {ticker} {day}')
                    records[day] = values
            frame = pd.DataFrame.from_dict(records, orient='index', columns=['open','high','low','close']).sort_index()
            frame.index = pd.to_datetime(frame.index,format='%Y%m%d').strftime('%Y-%m-%d')
            series.append(frame)
        if not series[0].index.equals(series[1].index):
            raise ValueError('ETF 간 거래일 불일치: 누락을 자동 보간하지 않습니다')
        self.days = series[0].index.to_numpy()
        self.open = np.stack([x['open'].to_numpy() for x in series],axis=1)
        self.close = np.stack([x['close'].to_numpy() for x in series],axis=1)
        self.valid_open = np.ones_like(self.open,dtype=bool)
        self.audit = []
        for j,frame in enumerate(series):
            if not np.isfinite(frame.to_numpy()).all() or (frame.to_numpy()<=0).any():
                raise ValueError('ETF 가격 누락 또는 비양수 가격')
            if ((frame['low']>frame['close']) | (frame['high']<frame['close'])).any():
                raise ValueError('ETF 종가 범위 오류')
            bad = (frame['low']>frame['open']) | (frame['high']<frame['open'])
            self.valid_open[:,j] = ~bad.to_numpy()
            self.audit += [{'kind':'invalid_open_range','symbol':self.symbols[j],'date':str(d)} for d in frame.index[bad]]
        self.macro = {}
        for line in Path(fred).read_text().splitlines():
            record = json.loads(line)
            rows = [r for r in record.get('observations',[]) if r['value']!='.']
            self.macro[record['series']] = pd.Series([float(r['value']) for r in rows],index=[r['date'] for r in rows],dtype=float)
        # 할인율은 실제 국채 보유 수익과 차이가 있으며, 전일 관측치를 샤프 대용치로 쓴다.
        rf = self.macro['DTB3']
        self.rf = rf.reindex(sorted(set(self.days)|set(rf.index))).ffill().reindex(self.days).shift(1).fillna(0).to_numpy()/100
        if (self.rf<0).any():
            self.rf = np.maximum(self.rf,0)

    def weights(self, i, p):
        windows = [round(x*p.window_scale) for x in [150,200,250]]
        horizons = [round(x*p.window_scale) for x in [126,189,252]]
        if i < max(windows+horizons):
            raise ValueError('신호를 계산할 과거 이력이 부족합니다')
        if p.family == 'buy_hold':
            return np.array([1.,0.])*(1-p.cash_buffer)
        if p.family in ['qqq_trend','qqq_gold']:
            trend = np.mean([self.close[i] > self.close[i-w+1:i+1].mean(axis=0) for w in windows],axis=0)
            result = np.array([trend[0], (1-trend[0])*trend[1] if p.family=='qqq_gold' else 0])
        elif p.family == 'dual_momentum':
            result = np.zeros(2)
            for horizon in horizons:
                momentum = self.close[i]/self.close[i-horizon]-1
                best = momentum.max()
                if best>0:
                    winners = np.isclose(momentum,best,rtol=0,atol=1e-12)
                    result += winners/winners.sum()/len(horizons)
        else:
            raise ValueError('알 수 없는 ETF 전략')
        return result*(1-p.cash_buffer)

    def run(self, p, start, end, initial=100000.):
        first = int(np.searchsorted(self.days,start))
        stop = int(np.searchsorted(self.days,end,side='right'))
        if p.delay<1 or not 0<=p.cash_buffer<1 or p.cost_multiplier<0 or p.window_scale<=0:
            raise ValueError('잘못된 체결 또는 전략 매개변수')
        if first <= round(252*p.window_scale) or stop<=first:
            raise ValueError('기간 또는 워밍업 이력이 부족합니다')
        rng = np.random.default_rng(p.seed)
        cash, shares, total_cost = initial, np.zeros(2), 0.
        trades, equity, weights = [], [], []
        # 초기 포트폴리오도 시작 직전 확정 종가로 수량을 정한다.
        target = np.floor(initial*self.weights(first-1,p)/self.close[first-1])
        due = first+p.delay-1
        month_ends = [i for i in range(first-1,stop) if i+1<len(self.days) and self.days[i][:7]!=self.days[i+1][:7]]
        signals = {i+p.signal_offset for i in month_ends if first <= i+p.signal_offset < stop}
        for i in range(first,stop):
            if target is not None and i>=due:
                delta = target-shares
                buys = rng.permutation(np.flatnonzero(delta>0))
                order = list(np.flatnonzero(delta<0))+list(buys)
                for j in order:
                    if not self.valid_open[i,j]:
                        raise ValueError(f'실제 주문일 시가 검증 실패: {self.days[i]} {self.symbols[j]}')
                    quantity = abs(delta[j])
                    side = 'buy' if delta[j]>0 else 'sell'
                    slip = .0005*p.cost_multiplier
                    if p.random_slippage:
                        slip *= rng.uniform(.5,1.5)
                    commission = .0001*p.cost_multiplier
                    price = self.open[i,j]*(1+slip if side=='buy' else 1-slip)
                    if side=='buy':
                        quantity = min(quantity,np.floor(max(cash,0)/(price*(1+commission))))
                    if quantity<=0:
                        continue
                    gross = quantity*price
                    fee = gross*commission
                    cost = fee+quantity*abs(price-self.open[i,j])
                    if side=='buy':
                        cash -= gross+fee
                        shares[j] += quantity
                    else:
                        cash += gross-fee
                        shares[j] -= quantity
                    total_cost += cost
                    trades.append({'date':str(self.days[i]),'symbol':self.symbols[j],'side':side,'quantity':int(quantity),'price':float(price),'cost':float(cost)})
                target = None
            value = cash+shares@self.close[i]
            if cash < -1e-7 or (shares<0).any() or not np.isfinite(value) or value<=0:
                raise ValueError('현금·수량·평가금액 제약 위반')
            equity.append(float(value))
            weights.append((shares*self.close[i]/value).tolist())
            if i in signals and p.family!='buy_hold':
                target = np.floor(value*self.weights(i,p)/self.close[i])
                due = i+(int(rng.integers(1,4)) if p.random_delay else p.delay)
        summary = metrics(equity,self.days[first:stop],self.rf[first:stop],initial)
        elapsed = (date.fromisoformat(end)-date.fromisoformat(start)).days
        summary['cagr_pct'] = 100*((equity[-1]/initial)**(365.25/elapsed)-1)
        summary.update({'parameters':asdict(p),'initial_usd':initial,'total_cost_usd':total_cost,'trade_count':len(trades),
                        'status':'PRICE_ONLY_DIVIDENDS_OMITTED_PRE_INVESTOR_TAX','requested_from':start,'requested_to':end})
        return {'summary':summary,'dates':self.days[first:stop].tolist(),'equity':equity,'weights':weights,'trades':trades,'sources':self.sources,'data_audit':self.audit}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prices',required=True)
    parser.add_argument('--fred',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--start',required=True)
    parser.add_argument('--end',required=True)
    parser.add_argument('--family',choices=['qqq_trend','qqq_gold','dual_momentum','buy_hold'],required=True)
    parser.add_argument('--scale',type=float,default=1.)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise FileExistsError('기존 실험을 덮어쓰지 않습니다')
    research = ETFResearch(args.prices,args.fred)
    result = research.run(ETFParameters(args.family,window_scale=args.scale),args.start,args.end)
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x') as stream:
        json.dump(result,stream,ensure_ascii=False)
    print(json.dumps(result['summary'],ensure_ascii=False))


if __name__=='__main__':
    main()
