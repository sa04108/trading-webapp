"""환경변수의 FRED 키로 지정한 공개 시계열만 조회하고 키는 출력하지 않는다."""
import argparse
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request


def fetch(series, start, end, destination):
    key = os.environ['FRED_API_KEY']
    output = Path(destination)
    if output.exists():
        raise FileExistsError('기존 FRED 원문을 덮어쓰지 않습니다')
    records = []
    for name in series:
        query = urllib.parse.urlencode({'series_id':name,'observation_start':start,
                                        'observation_end':end,'file_type':'json','api_key':key})
        try:
            with urllib.request.urlopen('https://api.stlouisfed.org/fred/series/observations?'+query,timeout=30) as response:
                data = json.load(response)
        except Exception as error:
            # URL을 포함할 수 있는 예외 본문에는 인증 키가 있으므로 종류만 전달한다.
            raise RuntimeError(f'FRED 조회 실패: {name} {type(error).__name__}') from None
        records.append({'series':name,'observations':data['observations']})
    with output.open('x') as stream:
        for record in records:
            stream.write(json.dumps(record,ensure_ascii=False)+'\n')
    print(json.dumps({'series':series,'start':start,'end':end,'output':str(output)}))


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--series',nargs='+',required=True)
    parser.add_argument('--start',required=True)
    parser.add_argument('--end',required=True)
    parser.add_argument('--output',required=True)
    args = parser.parse_args()
    fetch(args.series,args.start,args.end,args.output)
