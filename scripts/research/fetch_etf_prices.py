"""공개 미국 ETF 차트를 원문 그대로 별도 디렉터리에 저장한다."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.request


def fetch(destination):
    root = Path(destination)
    root.mkdir(parents=True,exist_ok=True)
    manifest = []
    for ticker,beginning in [('QQQ.O','199901010000'),('GLD','200401010000')]:
        for start,end in [(beginning,'201608290000'),('201501010000','202608290000')]:
            path = root/f'{ticker}-{start}-{end}.json'
            url = f'https://api.stock.naver.com/chart/foreign/item/{ticker}/day?startDateTime={start}&endDateTime={end}'
            if not path.exists():
                with urllib.request.urlopen(url,timeout=30) as response:
                    raw = response.read()
                rows = json.loads(raw)
                if not isinstance(rows,list) or not rows:
                    raise ValueError('빈 ETF 가격 응답')
                with path.open('xb') as stream:
                    stream.write(raw)
                time.sleep(.3)
            raw = path.read_bytes()
            rows = json.loads(raw)
            manifest.append({'file':path.name,'url':url,'sha256':hashlib.sha256(raw).hexdigest(),
                             'rows':len(rows),'first':rows[0]['localDate'],'last':rows[-1]['localDate']})
    # 응답 순서와 JSON 공백 차이는 원문 해시를 바꿀 수 있으므로 정규화 값도 별도 검증한다.
    with (root/'fetch-manifest.json').open('x') as stream:
        json.dump(manifest,stream,ensure_ascii=False,indent=2)
    print(json.dumps(manifest,ensure_ascii=False))


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination')
    fetch(parser.parse_args().destination)
