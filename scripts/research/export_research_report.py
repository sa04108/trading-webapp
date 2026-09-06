"""비공개 원자료에서 성과 요약·출처 해시·공유용 비교 그림만 내보낸다."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def export(root, destination):
    root,destination = Path(root),Path(destination)
    destination.mkdir(parents=True,exist_ok=True)
    registry = []
    for group in ['development','development-risk','validation','us-development','us-validation','us-final']:
        for path in sorted((root/group).glob('*.json')):
            record = json.loads(path.read_text())
            summary = record.get('result',record.get('summary',record))
            registry.append({'group':group,'source':path.relative_to(root).as_posix(),'summary':summary})
    robustness = json.loads((root/'us-robustness.json').read_text())
    audit = json.loads((root/'panel/data-audit.json').read_text())
    actions = json.loads((root/'panel/action-audit.json').read_text())
    references = json.loads((root/'panel/reference-audit.json').read_text())
    hashes = {}
    for source in ['market.jsonl.gz','dart_annual.jsonl.gz','annual.json','fred.jsonl','fred_us.jsonl','aligned_actions.json']:
        with (root/source).open('rb') as stream:
            hashes[source] = hashlib.file_digest(stream,'sha256').hexdigest()
    files = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob('*') if p.suffix in ['.py','.ts','.txt']}
    report = {'status':'NOT_ACHIEVED_NO_QUALIFYING_STRATEGY','created_at':datetime.now(timezone.utc).isoformat(),
        'period':{'from':'2016-08-28','to':'2026-08-28'},'development_parameter_runs':21,
        'preserved_performance_records':len(registry),'diagnostic_sensitivity_runs':len(robustness['sensitivity_runs']),
        'registry':registry,'robustness':robustness,'index_proxy_stress':json.loads((root/'ndx-proxy-stress.json').read_text()),
        'data_audit':{'snapshot':json.loads((root/'market.manifest.json').read_text()),
            'unknown_active_quote_gaps':audit['missing_active_without_nontrading_count'],
            'invalid_raw_ohlc':audit['invalid_ohlc_count'],'unaligned_corporate_actions':len(actions['unaligned']),
            'large_price_changes_after_action_alignment':len(actions['large_changes']),
            'missing_reference_quotes_among_eligible':len(references['missing_eligible_quotes']),
            'large_reference_price_changes':len(references['large_changes'])},
        'source_hashes':hashes,'research_code_hashes':files,
        'limitations':['원문 가격·재무 및 접속 정보는 이 파일에 포함하지 않습니다',
                       '등록된 실행 수는 독립 가설 수가 아니며 민감도 결과로 기본값을 다시 고르지 않습니다',
                       '국내 기업행위와 최초 공시 버전이 인증되지 않아 국내 수익률은 진단용입니다',
                       '미국 실적은 분배금 제외 가격수익이며 투자자 과세 전입니다']}
    (destination/'reliable-strategy-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    base = json.loads((root/'us-final/full-ten.json').read_text())
    buyhold = json.loads((root/'us-final/buy-hold.json').read_text())
    dates = pd.to_datetime(base['dates'])
    prices = None
    for line in (root/'fred_us.jsonl').read_text().splitlines():
        r = json.loads(line)
        if r['series']=='NASDAQ100':
            rows = [x for x in r['observations'] if x['value']!='.']
            prices = pd.Series([float(x['value']) for x in rows],index=[x['date'] for x in rows])
    initial = float(prices.loc[prices.index<base['dates'][0]].iloc[-1])
    ndx = prices.reindex(base['dates']).ffill().to_numpy()/initial
    series = [(np.asarray(base['equity'])/100000,'Frozen QQQ trend','#0f766e'),
              (np.asarray(buyhold['equity'])/100000,'QQQ buy and hold (price only)','#64748b'),
              (ndx,'Nasdaq-100 price index','#2563eb')]
    plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False})
    fig,(top,bottom) = plt.subplots(2,1,figsize=(11,7),sharex=True,gridspec_kw={'height_ratios':[2,1]},layout='constrained')
    for values,label,color in series:
        top.plot(dates,values,label=label,color=color,lw=1.8 if color=='#0f766e' else 1.1)
        drawdown = values/np.maximum.accumulate(np.r_[1.,values])[1:]-1
        bottom.plot(dates,drawdown*100,color=color,lw=1.2)
    top.axhline(6,color='#b45309',ls='--',lw=1,label='+500% target (6x initial wealth)')
    for ax in [top,bottom]:
        ax.axvspan(pd.Timestamp('2024-08-28'),dates[-1],color='#e2e8f0',alpha=.35)
        ax.grid(alpha=.15)
    top.set_title('Frozen strategy failed the 10-year return target',loc='left',fontweight='bold',fontsize=15)
    top.set_ylabel('Wealth / initial capital')
    top.legend(loc='upper left',frameon=True,facecolor='white',edgecolor='none',framealpha=.95,fontsize=9)
    bottom.set_ylabel('Drawdown (%)')
    bottom.xaxis.set_major_locator(mdates.YearLocator(2))
    bottom.xaxis.set_major_formatter(mdates.DateFormatter('%Y'))
    fig.supxlabel('2016-08-28 to 2026-08-28 | USD | 6 bps per side | cash earns 0 | dividends omitted | shaded: final 2 years',fontsize=8)
    assets = destination/'assets'; assets.mkdir(exist_ok=True)
    fig.savefig(assets/'reliable-strategy-validation.png',dpi=170)
    plt.close(fig)
    print(json.dumps({'performance_records':len(registry),'sensitivity_runs':len(robustness['sensitivity_runs']),'destination':str(destination)}))


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data',required=True)
    parser.add_argument('--output',required=True)
    args = parser.parse_args()
    export(args.data,args.output)
