"""수익률 평가 전에 사전 정의한 유동성 후보와 기업행위 누락의 교집합을 조사한다."""
import json
from pathlib import Path
import sys
import numpy as np
import pandas as pd

root = Path(sys.argv[1])
load = lambda name: np.load(root / f'{name}.npy', mmap_mode='r')
days, codes = load('days'), load('codes')
close, cap, value = load('close'), load('cap'), load('value')
common, volume, nontrading = load('common'), load('volume'), load('nontrading')
liquidity = pd.DataFrame(value).rolling(63, min_periods=63).median().to_numpy()
np.save(root / 'liquidity.npy', liquidity)
calendar = pd.to_datetime(days)
month_ends = np.flatnonzero(np.r_[calendar.month[:-1] != calendar.month[1:], True])
month_ends = month_ends[(days[month_ends] >= '2016-08-01') & (days[month_ends] <= '2026-08-28')]
eligible = np.zeros_like(common)
for i in month_ends:
 eligible[i] = common[i] & (liquidity[i] >= 1e9) & (cap[i] >= 50e9) & (volume[i] > 0) & ~nontrading[i] & np.isfinite(close[i-252])
coverage = np.flatnonzero(eligible.any(axis=0))
audit = json.loads((root / 'data-audit.json').read_text())
relevant = []
for a in audit['large_adjusted_changes']:
 i = int(np.searchsorted(days, a['date']))
 j = int(np.searchsorted(codes, a['code']))
 if np.any(eligible[max(0,i-22):min(len(days),i+274),j]): relevant.append(a)
result = {'eligible_union':len(coverage), 'eligible_counts':[int(eligible[i].sum()) for i in month_ends], 'relevant_large_changes':len(relevant), 'relevant_symbols':len({r['code'] for r in relevant}), 'anomalies':relevant, 'unknown_active_gaps':[[str(days[i]),str(codes[j])] for i,j in np.argwhere(load('missing'))]}
(root/'candidate-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
np.save(root/'eligible.npy',eligible)
print(json.dumps({k:v for k,v in result.items() if k not in ['anomalies','eligible_counts']},ensure_ascii=False))
