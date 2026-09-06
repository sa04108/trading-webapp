"""추가 ETF 연구의 공개 원문을 새 디렉터리로 수집하고 해시를 기록한다."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.request


def sources():
    root = 'https://api.stock.naver.com/chart/foreign/item/'
    charts = [('QLD-probe.json','QLD','200606190000','201608300000'),
              ('QLD-full-market.json','QLD','201501010000','202608290000'),
              ('QLD-market-extra.json','QLD','202608240000','202609050000'),
              ('GLD-market-extra.json','GLD','202608240000','202609050000')]
    return [(name,f'{root}{symbol}/day?startDateTime={start}&endDateTime={end}') for name,symbol,start,end in charts]+[
        ('QLD-issuer-nav.csv','https://accounts.profunds.com/etfdata/ByFund/QLD-historical_nav.csv'),
        ('proshares-splits.csv','https://accounts.profunds.com/etfdata/etf_splits.csv'),
        ('GLD-nav.xlsx','https://www.ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-gld.xlsx'),
        ('QQQ-invesco-performance.json','https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/QQQ/performance/standard?idType=ticker&performanceSubType=cumulative&productType=ETF')]


def fetch(destination):
    destination = Path(destination)
    if destination.exists():
        raise FileExistsError('새 자료 디렉터리가 필요합니다')
    destination.mkdir(parents=True,mode=0o700)
    manifest=[]
    for name,url in sources():
        # 접근 거절과 요청 제한은 자동 재시도하거나 다른 신원으로 우회하지 않는다.
        with urllib.request.urlopen(url,timeout=60) as response:
            raw=response.read()
        if not raw:
            raise ValueError(f'빈 공개 원문: {name}')
        if name.endswith('.json'):
            value=json.loads(raw)
            if name!='QQQ-invesco-performance.json' and (not isinstance(value,list) or not value):
                raise ValueError(f'잘못된 공개 차트: {name}')
        with (destination/name).open('xb') as stream:
            stream.write(raw)
        manifest.append({'file':name,'url':url,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)})
        time.sleep(.3)
    with (destination/'fetch-manifest.json').open('x') as stream:
        json.dump({'complete':True,'sources':manifest},stream,ensure_ascii=False,indent=2)
    print(json.dumps(manifest,ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination')
    fetch(parser.parse_args().destination)
