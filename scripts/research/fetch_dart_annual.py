"""허용된 API 예산 안에서 연간 주요계정을 조회하고 원응답을 압축 보존한다."""
import argparse
import gzip
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import urllib.parse
import urllib.request


def fetch(corp_codes, api_key, usage_database=None, max_calls=330):
    """운영 원장과 이번 연구 호출을 합산해 40,000회보다 여유 있게 멈춘다."""
    if not isinstance(corp_codes,list) or any(not isinstance(c,str) or len(c)!=8 or not c.isdigit() for c in corp_codes):
        raise ValueError('DART 회사코드 문자열 목록이 필요합니다')
    calls = 0
    deadline = time.monotonic() + 780
    completed = True
    connection = None
    if usage_database:
        connection = sqlite3.connect(Path(usage_database).resolve().as_uri() + '?mode=ro', uri=True)
    with gzip.GzipFile(fileobj=sys.stdout.buffer, mode='wb', compresslevel=1, mtime=0) as stream:
        def emit(data):
            stream.write((json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n').encode())
        emit({'format': 1, 'corp_codes': corp_codes, 'from_year': 2015, 'to_year': 2025})
        for year in range(2015, 2026):
            for offset in range(0, len(corp_codes), 100):
                # 읽기 전용 원장에는 별도 연구 호출이 없으므로 3회 표본 조회도 더한다.
                used = 0
                if connection:
                    date = time.strftime('%Y-%m-%d', time.gmtime(time.time() + 9 * 3600))
                    row = connection.execute("SELECT calls_used FROM external_api_daily_usage WHERE api='DART' AND quota_scope='daily' AND usage_date_kst=?", (date,)).fetchone()
                    used = row[0] if row else 0
                if calls >= max_calls or used + calls + 3 >= 39900 or time.monotonic() >= deadline:
                    completed = False
                    break
                batch = corp_codes[offset:offset + 100]
                query = urllib.parse.urlencode({'crtfc_key': api_key, 'corp_code': ','.join(batch), 'bsns_year': year, 'reprt_code': '11011'})
                calls += 1
                try:
                    with urllib.request.urlopen('https://opendart.fss.or.kr/api/fnlttMultiAcnt.json?' + query, timeout=12) as response:
                        result = json.load(response)
                except Exception as error:
                    # URL과 원 예외에는 키가 포함될 수 있으므로 예외 종류만 남긴다.
                    result = {'status': 'TRANSPORT_ERROR', 'error_type': type(error).__name__}
                emit({'year': year, 'batch': offset // 100, 'requested': batch, 'response': result})
                if result.get('status') not in ('000', '013'):
                    completed = False
                    break
                if offset % 500 == 0:
                    print(f"{year} {offset // 100 + 1}/{(len(corp_codes) + 99) // 100}: {result.get('status')}", file=sys.stderr, flush=True)
                time.sleep(0.15)
            if not completed:
                break
        emit({'complete': completed, 'calls': calls})
    if connection:
        connection.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corp-codes',required=True)
    parser.add_argument('--usage-database',required=True)
    parser.add_argument('--max-calls',type=int,default=330)
    args = parser.parse_args()
    fetch(json.loads(Path(args.corp_codes).read_text()),os.environ['DART_API_KEY'],args.usage_database,args.max_calls)
