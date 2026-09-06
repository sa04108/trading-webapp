"""운용사 NAV·분할과 독립 시장 가격을 대조해 실제 단위의 ETF 패널을 만든다."""
import argparse
import csv
from datetime import datetime
import hashlib
import json
from pathlib import Path

import numpy as np
import openpyxl
import pandas as pd


def load_chart(paths):
    records = {}
    for path in paths:
        for row in json.loads(Path(path).read_text()):
            day = datetime.strptime(row['localDate'],'%Y%m%d').strftime('%Y-%m-%d')
            value = [float(row[k]) for k in ['openPrice','highPrice','lowPrice','closePrice','accumulatedTradingVolume']]
            if day in records and records[day]!=value:
                raise ValueError(f'원문 중첩 가격 충돌: {day}')
            records[day] = value
    return pd.DataFrame.from_dict(records,orient='index',columns=['open','high','low','close','volume']).sort_index()


def prepare(root, destination):
    root,destination = Path(root),Path(destination)
    if destination.exists():
        raise FileExistsError('기존 확장 패널을 덮어쓰지 않습니다')
    sources = [root/'us-diversification/QLD-probe.json',root/'us-diversification/QLD-full-market.json',
               *sorted((root/'us-etf').glob('GLD-*.json')),root/'us-diversification/QLD-issuer-nav.csv',
               root/'us-diversification/proshares-splits.csv',root/'us-diversification/GLD-nav.xlsx']
    extras = [root/f'us-diversification/{symbol}-market-extra.json' for symbol in ['QLD','GLD']]
    qld = load_chart(sources[:2]+([extras[0]] if extras[0].exists() else []))
    gld = load_chart(sorted((root/'us-etf').glob('GLD-*.json'))+([extras[1]] if extras[1].exists() else []))
    sources += [p for p in extras if p.exists()]
    if not qld.index.equals(gld.index):
        raise ValueError('QLD·GLD 시장 거래일 불일치')
    days = np.asarray(qld.index.tolist(),dtype=str)
    with (root/'us-diversification/QLD-issuer-nav.csv').open() as stream:
        nav_rows = list(csv.DictReader(stream))
    qld_nav = pd.Series({datetime.strptime(x['Date'],'%m/%d/%Y').strftime('%Y-%m-%d'):float(x['NAV']) for x in nav_rows}).sort_index()
    workbook = openpyxl.load_workbook(root/'us-diversification/GLD-nav.xlsx',read_only=True,data_only=True)
    gld_nav = {}
    for row in workbook.active.values:
        if isinstance(row[0],str) and isinstance(row[1],(float,int)):
            try:
                day = datetime.strptime(row[0],'%d-%b-%Y').strftime('%Y-%m-%d')
            except ValueError:
                continue
            gld_nav[day] = float(row[1])
    workbook.close()
    gld_nav = pd.Series(gld_nav).sort_index()
    # 공식 보도자료와 OCC 공지가 명시한 거래 적용일을 사용하고 CSV 차이는 보존한다.
    overrides = {'2025-11-21':'2025-11-20'}
    split_events = []
    with (root/'us-diversification/proshares-splits.csv').open() as stream:
        for row in csv.DictReader(stream):
            if row['Symbol']!='QLD':
                continue
            original = datetime.strptime(row['Date of Split'],'%m/%d/%Y').strftime('%Y-%m-%d')
            ratio = float(row['Ratio'])
            if row['Split Type']!='Forward':
                raise ValueError('검증하지 않은 역분할이 추가되었습니다')
            split_events.append({'date':overrides.get(original,original),'ratio':ratio,'source_date':original,
                                 'source_override':'https://www.proshares.com/press-releases/proshares-announces-etf-share-splits5' if original in overrides else None})
    split_events.sort(key=lambda x:x['date'])
    future_factor = np.ones((len(days),2))
    split = np.ones((len(days),2))
    for event in split_events:
        future_factor[days<event['date'],0] *= event['ratio']
        match = np.flatnonzero(days==event['date'])
        if len(match):
            split[match[0],0] = event['ratio']
    frames = [qld,gld]
    arrays = {'days':days,'symbols':np.array(['QLD','GLD']),
              'signal_close':np.column_stack([f.close for f in frames]),'split':split,'future_factor':future_factor}
    for key in ['open','high','low','close']:
        arrays[key] = np.column_stack([f[key] for f in frames])*future_factor
    arrays['volume'] = np.column_stack([f.volume for f in frames])/future_factor
    arrays['valid_open'] = (arrays['open']>=arrays['low']) & (arrays['open']<=arrays['high'])
    if ((arrays['close']<arrays['low']) | (arrays['close']>arrays['high'])).any():
        raise ValueError('시장 종가 범위 오류')
    for key in ['open','high','low','close','volume']:
        if not np.isfinite(arrays[key]).all() or (arrays[key]<=0).any():
            raise ValueError(f'필수 시장 입력 누락: {key}')
    nav = pd.concat([qld_nav.rename('QLD'),gld_nav.rename('GLD')],axis=1).dropna()
    nav = nav.loc[(nav.index>=qld_nav.index[0]) & (nav.index<=days[-1])]
    arrays['nav_days'], arrays['nav_close'] = np.asarray(nav.index.tolist(),dtype=str), nav.to_numpy()
    gaps = []
    comparisons = []
    for j,reference in enumerate([qld_nav,gld_nav]):
        aligned = reference.reindex(days).to_numpy()
        if not np.isfinite(aligned).all():
            gaps += [[str(days[i]),str(arrays['symbols'][j])] for i in np.flatnonzero(~np.isfinite(aligned))]
        deviation = arrays['signal_close'][:,j]/aligned-1
        comparisons.append({'symbol':str(arrays['symbols'][j]),'market_nav_relative_gap_quantiles':np.nanquantile(deviation,[0,.01,.5,.99,1]).tolist(),
                            'abs_gap_over_5pct':int((np.abs(deviation)>.05).sum())})
    audit = {'status':'MARKET_PRICES_WITH_ISSUER_SPLITS_DIVIDENDS_PENDING','market_from':str(days[0]),'market_to':str(days[-1]),
             'market_days':len(days),'nav_from':str(nav.index[0]),'nav_to':str(nav.index[-1]),'nav_days':len(nav),
             'split_events':split_events,'invalid_opens':[[str(days[i]),str(arrays['symbols'][j])] for i,j in np.argwhere(~arrays['valid_open'])],
             'missing_nav':gaps,'comparison':comparisons,
             'nav_note':'GLD NAV는 런던 금 가격 기준이며 미국 종가와 시점이 달라 가격 차이를 모두 오류로 볼 수 없습니다',
             'source_hashes':{p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}}
    partial = destination.with_name(destination.name+'.partial')
    if partial.exists():
        raise FileExistsError('미완료 확장 패널을 먼저 확인해야 합니다')
    partial.mkdir(parents=True)
    for name,array in arrays.items():
        np.save(partial/f'{name}.npy',array,allow_pickle=False)
    (partial/'audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')
    partial.rename(destination)
    print(json.dumps(audit,ensure_ascii=False,indent=2))


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data',required=True)
    parser.add_argument('--output',required=True)
    args = parser.parse_args()
    prepare(args.data,args.output)
