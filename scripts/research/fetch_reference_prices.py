"""독립 시세의 원본 차트를 캐시하여 분할 보정과 가격 누락을 대조한다."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import gzip
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import numpy as np


def fetch_one(code, root):
    target = root / f'{code}.xml.gz'
    try:
        if target.exists():
            body = gzip.decompress(target.read_bytes())
        else:
            url = f'https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=day&count=3000&requestType=0'
            with urllib.request.urlopen(url, timeout=20) as response:
                body = response.read()
            ET.fromstring(body.decode('euc-kr'))
            target.write_bytes(gzip.compress(body, compresslevel=1, mtime=0))
            time.sleep(0.15)
        data = ET.fromstring(body.decode('euc-kr'))
        rows = [x.attrib['data'].split('|') for x in data.iter('item')]
        return {'code': code, 'count': len(rows), 'first': rows[0][0] if rows else None,
                'last': rows[-1][0] if rows else None, 'sha256': hashlib.sha256(body).hexdigest()}
    except Exception as error:
        return {'code': code, 'error_type': type(error).__name__}


if __name__ == '__main__':
    panel, root = Path(sys.argv[1]), Path(sys.argv[2])
    root.mkdir(parents=True, exist_ok=True)
    codes = np.load(panel/'codes.npy')
    eligible = np.load(panel/'eligible.npy', mmap_mode='r')
    requested = [str(c) for c in codes[np.any(eligible,axis=0)]]
    records = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(fetch_one, code, root) for code in requested]
        for future in as_completed(futures):
            records.append(future.result())
            if len(records) % 100 == 0:
                print(f'{len(records)}/{len(requested)}', flush=True)
    (root/'manifest.json').write_text(json.dumps(sorted(records,key=lambda r:r['code']),ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'requested':len(requested),'with_rows':sum(r.get('count',0)>0 for r in records),'errors':sum('error_type' in r for r in records)}))
