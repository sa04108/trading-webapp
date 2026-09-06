"""독립 수정주가를 원가격 패널과 날짜별로 대조하며 거래일 누락은 채우지 않는다."""
import gzip
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import numpy as np
import pandas as pd

root, source = Path(sys.argv[1]),Path(sys.argv[2])
load = lambda name: np.load(root/f'{name}.npy',mmap_mode='r')
days,codes,raw = load('days'),load('codes'),load('close')
di,ci = pd.Index(np.char.replace(days,'-','')),pd.Index(codes)
close,opening = np.full(raw.shape,np.nan),np.full(raw.shape,np.nan)
for path in source.glob('*.xml.gz'):
 code=path.name[:6]
 j=ci.get_indexer([code])[0]
 if j<0: continue
 tree=ET.fromstring(gzip.decompress(path.read_bytes()).decode('euc-kr'))
 rows=[item.attrib['data'].split('|') for item in tree.iter('item')]
 if not rows: continue
 indexes=di.get_indexer([r[0] for r in rows])
 for i,row in zip(indexes,rows):
  if i<0: continue
  if float(row[4])>0: close[i,j]=float(row[4])
  if float(row[1])>0: opening[i,j]=float(row[1])
# 실제 거래불가로 확인한 날만 직전 독립 종가를 이월한다.
carried=pd.DataFrame(close).ffill().to_numpy()
close=np.where(load('nontrading')&~np.isfinite(close),carried,close)
with np.errstate(invalid='ignore',divide='ignore'):
 # 체결 수량이 당일 종가를 참조하지 않도록 시가의 단위 변환계수를 사용한다.
 factor=opening/load('open')
 factor[~np.isfinite(factor)]=np.nan
 factor=pd.DataFrame(factor).ffill().to_numpy()
 changes=close[1:]/close[:-1]-1
large=[]
for i,j in np.argwhere((np.abs(changes)>.35)&load('common')[1:]&(load('volume')[1:]>0)):
 large.append({'date':str(days[i+1]),'code':str(codes[j]),'return':float(changes[i,j])})
missing=load('eligible')&~np.isfinite(close)
report={'source':'Npay KRX daily chart, 3000 rows requested per historical eligible code; not a total-return series',
        'missing_eligible_quotes':[[str(days[i]),str(codes[j])] for i,j in np.argwhere(missing)],
        'large_changes':large}
(root/'reference-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
for name,panel in [('reference_close',close),('reference_open',opening),('reference_factor',factor)]:
 np.save(root/f'{name}.npy',panel)
print(json.dumps({'missing_eligible_quotes':int(missing.sum()),'large_changes':len(large)}))
