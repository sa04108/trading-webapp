"""DART 원응답을 공시일 이후에만 사용할 연간 재무 관측으로 정규화한다."""
import collections
import gzip
import json
from pathlib import Path
import sys


def amount(raw):
    if raw is None: return None
    value = str(raw).replace(',', '').strip()
    if value in ('', '-', '해당사항 없음'): return None
    if value.startswith('(') and value.endswith(')'): value = '-' + value[1:-1]
    try: return float(value)
    except ValueError: return None


def prepare(source, destination):
    grouped = collections.defaultdict(lambda: collections.defaultdict(list))
    complete = False
    for line in gzip.open(source, 'rt'):
        record = json.loads(line)
        if 'complete' in record: complete = record['complete']
        for row in record.get('response', {}).get('list', []):
            field = {'영업이익':'operating_income', '영업이익(손실)':'operating_income', '자본총계':'equity'}.get(row.get('account_nm'))
            if field is None or row.get('currency') not in ('KRW', None, ''): continue
            value = amount(row.get('thstrm_amount'))
            if value is None: continue
            receipt = row.get('rcept_no','')
            if len(receipt) != 14 or not receipt.isdigit(): continue
            grouped[(row['stock_code'], record['year'], row['fs_div'])][field].append((value, receipt))
    observations, conflicts = [], []
    for (code, year, basis), fields in grouped.items():
        if any(len({x[0] for x in rows}) > 1 for rows in fields.values()):
            conflicts.append([code,year,basis]); continue
        if set(fields) != {'operating_income','equity'}: continue
        receipt = max(x[1] for rows in fields.values() for x in rows)
        observations.append({'code':code,'year':year,'basis':basis,'receipt':receipt,
            'asof':f'{receipt[:4]}-{receipt[4:6]}-{receipt[6:8]}',
            **{k:rows[0][0] for k,rows in fields.items()}})
    result = {'complete':complete,'observations':sorted(observations,key=lambda r:(r['asof'],r['code'],r['year'],r['basis'])),
              'conflicts':conflicts,'source':'DART fnlttMultiAcnt annual 2015-2025; latest API response, availability uses returned receipt date'}
    Path(destination).write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n')
    print(json.dumps({'complete':complete,'observations':len(observations),'conflicts':len(conflicts),
        'by_year':dict(collections.Counter(x['year'] for x in observations)),
        'late_receipts_over_2years':sum(int(x['asof'][:4])>x['year']+2 for x in observations)}))


if __name__ == '__main__': prepare(sys.argv[1],sys.argv[2])
