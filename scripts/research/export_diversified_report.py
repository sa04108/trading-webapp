"""고정 분산 후보의 결과·실험 이력·위험 판정을 공유 가능한 산출물로 저장한다."""
import argparse
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def attribution(panel, result):
    """분할 후 보유 수량과 체결 장부로 자산별 달러 손익을 독립 계산한다."""
    data = {p.stem:np.load(p,allow_pickle=False) for p in Path(panel).glob('*.npy')}
    by_day = {}
    for trade in result['trades']:
        by_day.setdefault(trade['date'], []).append(trade)
    shares, cumulative, rows = np.zeros(2), np.zeros(2), []
    previous = result['summary']['initial_usd']
    for day, value in zip(result['dates'], result['equity']):
        i = int(np.searchsorted(data['days'], day))
        pnl = shares * (data['split'][i]*data['close'][i]-data['close'][i-1])
        shares *= data['split'][i]
        for trade in by_day.get(day, []):
            j = list(data['symbols']).index(trade['symbol'])
            sign = 1 if trade['side']=='buy' else -1
            pnl[j] += sign*trade['quantity']*(data['close'][i,j]-trade['price'])-trade['commission']
            shares[j] += sign*trade['quantity']
        if abs(pnl.sum()-(value-previous))>1e-6:
            raise AssertionError('일별 자산 손익 합계 불일치')
        cumulative += pnl
        rows.append({'date':day,'pnl_usd':pnl.tolist()})
        previous = value
    return {'symbols':data['symbols'].tolist(), 'cumulative_pnl_usd':cumulative.tolist(),
            'initial_capital_return_contribution_pp':(cumulative/result['summary']['initial_usd']*100).tolist(),
            'annual_pnl_usd':{year:np.sum([x['pnl_usd'] for x in rows if x['date'].startswith(year)],axis=0).tolist()
                              for year in sorted(set(x['date'][:4] for x in rows))},
            'note':'실제 매매를 포함한 가산 달러 손익 기여이며 고정 비중 자산 수익률 합산이 아닙니다'}


def export(source, panel, development, destination):
    source, destination = Path(source), Path(destination)
    result = json.loads(source.read_text())
    result['attribution'] = attribution(panel, result['base'])
    registry = []
    for p in sorted(Path(development).glob('*.json')):
        value = json.loads(p.read_text())
        if 'summary' in value:
            registry.append({'file':p.name, 'summary':value['summary']})
        else:
            registry.append({'file':p.name, 'gate_passed':value['development_gate_passed'],
                             'control':value['control']['summary'], 'runs':[r['summary'] for r in value['runs']]})
    result['development_registry'] = registry
    usd, krw_summary = result['base']['summary'], result['krw']['summary']
    usd_risk_passed = usd['sharpe'] >= 1 and usd['mdd_pct'] >= -35
    earlier = [x for x in result['historical'] if x['label']=='earlier_ten_year']
    result['decision'] = {'selected_research_candidate':'QLD 40 / GLD 60 monthly',
                          'strict_acceptance':'USD_RISK_PASSED' if usd_risk_passed else 'FAILED_USD_RISK_GATE',
                          'target_500_pct':usd['total_return_pct']>500,
                          'exceeds_same_currency_ndx_in_primary_period':usd['total_return_pct']>result['ndx']['usd']['total_return_pct'] and krw_summary['total_return_pct']>result['ndx']['krw']['total_return_pct'],
                          'usd_sharpe_at_least_1':usd['sharpe']>=1, 'usd_mdd_at_most_35_pct':usd['mdd_pct']>=-35,
                          'krw_sharpe_at_least_1':krw_summary['sharpe']>=1, 'krw_mdd_at_most_35_pct':krw_summary['mdd_pct']>=-35,
                          'independent_new_holdout':False,
                          'consistent_all_ten_year_windows':all(x['usd']['total_return_pct']>max(500,x['ndx']['usd']['total_return_pct']) for x in earlier),
                          'deployment_authorized':False,
                          'note':'가장 유력한 연구 후보 하나를 남기되 엄격 위험 관문 통과로 표시하지 않습니다'}
    result['export_provenance'] = {'validation_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
                                 'exporter_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    destination.mkdir(parents=True, exist_ok=True)
    # 원문 개별 시세는 내보내지 않고 파생 평가액과 체결·판정 기록을 보존한다.
    (destination/'diversified-strategy-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    base, krw, ndx = result['base'], result['krw'], result['ndx']
    days = pd.to_datetime(base['dates'])
    fig, axes = plt.subplots(2,2,figsize=(13,8),constrained_layout=True)
    fig.suptitle('QLD 40% / GLD 60%: retrospective validation, 2016-08-28 to 2026-08-28',fontsize=14)
    for col, currency, strategy, bench, capital in [(0,'USD',base['equity'],ndx['equity_usd'],base['summary']['initial_usd']),
                                                     (1,'KRW',krw['equity'],ndx['equity_krw'],1e8)]:
        for values,label,color in [(strategy,'40/60 after modeled costs','#227b89'),(bench,'Nasdaq-100 price index','#b77a2f')]:
            values=np.asarray(values)
            axes[0,col].plot(days,values/capital,label=label,color=color,lw=1.5)
            drawdown=100*(values/np.maximum.accumulate(np.r_[capital,values])[1:]-1)
            axes[1,col].plot(days,drawdown,label=label,color=color,lw=1)
        axes[0,col].set_title(currency+' wealth multiple'); axes[0,col].set_yscale('log')
        axes[0,col].legend(loc='upper left',fontsize=8)
        axes[1,col].set_title(currency+' drawdown (%)')
        axes[1,col].axhline(-35,color='#a23b3b',ls='--',lw=.8)
        for row in [0,1]:
            axes[row,col].grid(alpha=.2)
    fig.text(.5,-.025,f"Price only; investor taxes excluded. Not a fresh holdout. USD Sharpe {usd['sharpe']:.3f}, drawdown {usd['mdd_pct']:.2f}%. Strict risk gates: {'pass' if usd_risk_passed else 'fail'}.",ha='center',fontsize=9)
    asset=destination/'assets'; asset.mkdir(exist_ok=True)
    fig.savefig(asset/'diversified-strategy-validation.png',dpi=170,bbox_inches='tight')
    plt.close(fig)
    print(json.dumps({'decision':result['decision'],'attribution':result['attribution'],'development_files':len(registry)},ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['source','panel','development','output']:
        parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    export(args.source,args.panel,args.development,args.output)
