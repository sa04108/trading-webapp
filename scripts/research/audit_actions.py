"""운영 엔진으로 정렬한 기업행위를 적용하고 남은 가격 단절을 따로 감사한다."""
import json
from pathlib import Path
import sys
import numpy as np
import pandas as pd

root = Path(sys.argv[1])
aligned = json.loads(Path(sys.argv[2]).read_text())
load = lambda name: np.load(root / f'{name}.npy', mmap_mode='r')
days, codes, close = load('days'), load('codes'), load('close')
blocked = {(r['symbol'],r['periodKey']) for r in aligned['unaligned']}
split = np.ones(close.shape)
for row in aligned['facts']:
 if (row['key'],row['periodKey']) in blocked: continue
 i, j = int(np.searchsorted(days,row['periodKey'])), int(np.searchsorted(codes,row['key']))
 if i < len(days) and j < len(codes) and codes[j] == row['key']: split[i,j] *= row['value']
adjusted = pd.DataFrame(np.where(close > 0,close,np.nan)).ffill().to_numpy() * np.cumprod(split,axis=0)
with np.errstate(invalid='ignore',divide='ignore'): returns = adjusted[1:] / adjusted[:-1] - 1
anomalies = []
for i,j in np.argwhere((np.abs(returns)>0.35) & load('common')[1:] & (load('volume')[1:]>0)):
 i += 1
 anomalies.append({'date':str(days[i]),'code':str(codes[j]),'return':float(returns[i-1,j]),'split':float(split[i,j])})
np.save(root/'split_aligned.npy',split)
np.save(root/'adjusted_aligned.npy',adjusted)
result={'unaligned':aligned['unaligned'],'large_changes':anomalies}
(root/'action-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'unaligned':len(blocked),'large_changes_after_engine_alignment':len(anomalies),'with_aligned_split':sum(r['split']!=1 for r in anomalies)}))
