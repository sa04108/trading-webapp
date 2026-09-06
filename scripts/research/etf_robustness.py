"""고정한 ETF 후보의 민감도와 짝지은 블록 재표본 불확실성을 기록한다."""
import argparse
from dataclasses import replace
import json
from pathlib import Path

import numpy as np

from etf_backtest import ETFResearch, ETFParameters


def block_intervals(strategy, benchmark, rf, length, draws=5000, seed=20260906):
    rng = np.random.default_rng(seed)
    n = len(strategy)
    values = []
    excess = strategy-((1+rf)**(1/252)-1)
    for _ in range(draws):
        starts = rng.integers(0,n,size=int(np.ceil(n/length)))
        indices = ((starts[:,None]+np.arange(length))%n).ravel()[:n]
        sample = excess[indices]
        sharpe = sample.mean()/sample.std(ddof=1)*np.sqrt(252)
        growth = np.expm1(np.log1p(strategy[indices]).mean()*252)
        benchmark_growth = np.expm1(np.log1p(benchmark[indices]).mean()*252)
        values.append([sharpe,100*growth,100*(growth-benchmark_growth)])
    return {'block_days':length,'draws':draws,'seed':seed,'columns':['sharpe','cagr_pct','cagr_excess_ndx_pp'],
            'quantiles':{str(q):np.quantile(values,q,axis=0).tolist() for q in [.025,.5,.975]},
            'resample_fraction_outperforming_ndx':float((np.asarray(values)[:,2]>0).mean()),
            'interpretation':'고정 전략의 관측 일수익률 재표본이며 미래 확률이나 신규 표본 외 실적이 아닙니다'}


def analyze(research, base, start, end):
    p = ETFParameters('qqq_trend')
    cases = []
    for scale in np.linspace(.8,1.2,9):
        cases.append(('window_scale',float(scale),replace(p,window_scale=float(scale))))
    for delay in [1,2,3]:
        cases.append(('execution_delay',delay,replace(p,delay=delay)))
    for cost in [1,2,4]:
        cases.append(('cost_multiplier',cost,replace(p,cost_multiplier=cost)))
    for offset in [-3,-1,0,1,3]:
        cases.append(('signal_offset',offset,replace(p,signal_offset=offset)))
    for buffer in [0,.01,.03]:
        cases.append(('cash_buffer',buffer,replace(p,cash_buffer=buffer)))
    for seed in range(30):
        cases.append(('order_seed',seed,replace(p,seed=seed)))
    for seed in range(100):
        cases.append(('execution_noise_seed',seed,replace(p,seed=seed,random_delay=True,random_slippage=True)))
    sensitivities = []
    for kind,value,params in cases:
        result = research.run(params,start,end)['summary']
        sensitivities.append({'kind':kind,'value':value,'summary':result})
    for initial in [1000,10000,100000,1000000]:
        result = research.run(p,start,end,initial=initial)['summary']
        sensitivities.append({'kind':'initial_usd','value':initial,'summary':result})
    equity = np.asarray(base['equity'])
    returns = equity/np.r_[100000,equity[:-1]]-1
    dates = np.asarray(base['dates'])
    ndx = research.macro['NASDAQ100']
    ndx_days = ndx.reindex(sorted(set(ndx.index)|set(dates))).ffill().reindex(dates).to_numpy()
    before = float(ndx.loc[ndx.index<dates[0]].iloc[-1])
    benchmark = ndx_days/np.r_[before,ndx_days[:-1]]-1
    indices = np.searchsorted(research.days,dates)
    intervals = [block_intervals(returns,benchmark,research.rf[indices],length) for length in [21,63,126]]
    annual = []
    for year in sorted(set(d[:4] for d in dates)):
        mask = np.array([d.startswith(year) for d in dates])
        annual.append({'year':year,'from':dates[mask][0],'to':dates[mask][-1],
                       'strategy_pct':100*np.expm1(np.log1p(returns[mask]).sum()),
                       'ndx_pct':100*np.expm1(np.log1p(benchmark[mask]).sum()),
                       'cash_weight_mean':float(1-np.mean(np.asarray(base['weights'])[mask].sum(axis=1)))})
    ranges = {}
    for kind in sorted(set(x['kind'] for x in sensitivities)):
        summaries = [x['summary'] for x in sensitivities if x['kind']==kind]
        ranges[kind] = {metric:{'min':min(x[metric] for x in summaries),'median':float(np.median([x[metric] for x in summaries])),
                               'max':max(x[metric] for x in summaries)} for metric in ['total_return_pct','sharpe','mdd_pct']}
    return {'status':'REJECTED_TARGET_RETURN_AND_SHARPE','base':base['summary'],'sensitivity_ranges':ranges,
            'sensitivity_runs':sensitivities,'bootstrap':intervals,'annual':annual,
            'benchmark_ndx_price_return_pct':100*(ndx_days[-1]/before-1),
            'note':'최종 성과를 본 뒤 수행한 진단이며 파라미터 재선택에 사용하지 않습니다'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prices',required=True)
    parser.add_argument('--fred',required=True)
    parser.add_argument('--base',required=True)
    parser.add_argument('--output',required=True)
    args = parser.parse_args()
    path = Path(args.output)
    if path.exists():
        raise FileExistsError('기존 검증 결과를 덮어쓰지 않습니다')
    research = ETFResearch(args.prices,args.fred)
    base = json.loads(Path(args.base).read_text())
    result = analyze(research,base,base['summary']['requested_from'],base['summary']['requested_to'])
    with path.open('x') as stream:
        json.dump(result,stream,ensure_ascii=False,indent=2)
    print(json.dumps({'ranges':result['sensitivity_ranges'],'bootstrap':result['bootstrap']},ensure_ascii=False))


if __name__=='__main__':
    main()
