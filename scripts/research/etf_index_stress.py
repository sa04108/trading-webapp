"""고정 규칙을 과거 NDX 종가에 적용하되 실제 ETF 체결 실적과 구분한다."""
import argparse
import json
from pathlib import Path
import numpy as np
from etf_backtest import ETFResearch, ETFParameters


def stress(prices, fred, output):
    output = Path(output)
    if output.exists():
        raise FileExistsError('기존 지수 대용치 실험을 덮어쓰지 않습니다')
    actual = ETFResearch(prices,fred)
    proxy = ETFResearch.__new__(ETFResearch)
    ndx = actual.macro['NASDAQ100']
    proxy.days = ndx.index.to_numpy()
    proxy.close = np.column_stack([ndx.to_numpy(),np.ones(len(ndx))])
    # 시가 자료를 만들지 않고 다음 거래일 종가를 가상 체결 가격으로 명시한다.
    proxy.open = proxy.close.copy()
    proxy.valid_open = np.ones_like(proxy.open,dtype=bool)
    proxy.rf = actual.macro['DTB3'].reindex(ndx.index).ffill().shift(1).fillna(0).to_numpy()/100
    proxy.symbols = ['NDX_PROXY','UNUSED']
    proxy.sources = [{'series':'NASDAQ100','execution':'next session close index proxy; not ETF fills'}]
    proxy.audit = []
    results = []
    for name,start,end in [('dot-com','2000-03-01','2003-03-31'),('financial-crisis','2007-10-01','2009-03-31')]:
        for family in ['qqq_trend','buy_hold']:
            # 큰 가상 원금은 지수 단위의 정수 반올림 영향을 줄이기 위한 계산 장치다.
            result = proxy.run(ETFParameters(family),start,end,initial=1e8)
            result['summary']['status'] = 'INDEX_NEXT_CLOSE_PROXY_NOT_ETF_EXECUTABLE_RETURN'
            results.append({'scenario':name,**result['summary']})
    with output.open('x') as stream:
        json.dump(results,stream,ensure_ascii=False,indent=2)
    print(json.dumps(results,ensure_ascii=False))


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prices',required=True)
    parser.add_argument('--fred',required=True)
    parser.add_argument('--output',required=True)
    args = parser.parse_args()
    stress(args.prices,args.fred,args.output)
