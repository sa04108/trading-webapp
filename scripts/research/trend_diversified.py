"""기존 추세 투표를 고정 주식·금 배분의 위험 축소에만 적용한다."""
import argparse
from dataclasses import replace
import json
from pathlib import Path

import numpy as np

from diversified_backtest import DiversifiedParameters, DiversifiedResearch
from diversified_validation import asof


class TrendDiversifiedResearch(DiversifiedResearch):
    def weights(self, i, p):
        if p.family != 'trend_mix':
            return super().weights(i, p)
        windows = [round(x*p.window_scale) for x in [150,200,250]]
        if i < max(windows)-1 or min(windows) < 2:
            raise ValueError('추세 투표 이력이 부족합니다')
        if not hasattr(self, 'trend_prices'):
            self.trend_prices = np.column_stack([asof(self.macro['NASDAQ100'], self.days), self.data['signal_close'][:,1]])
        votes = np.mean([self.trend_prices[i] > self.trend_prices[i-window+1:i+1].mean(axis=0) for window in windows], axis=0)
        return np.array([p.equity_weight,1-p.equity_weight]) * votes * (1-p.cash_buffer)


def develop(panel, fred, output):
    output = Path(output)
    if output.exists():
        raise FileExistsError('기존 추세 분산 개발 기록을 덮어쓰지 않습니다')
    research = TrendDiversifiedResearch(panel, fred)
    p = DiversifiedParameters(family='trend_mix')
    start, end = '2011-10-01', '2016-08-27'
    control = research.run(DiversifiedParameters(), start, end)
    results = [research.run(replace(p,window_scale=scale), start, end) for scale in [.8,1.,1.2]]
    median = float(np.median([x['summary']['sharpe'] for x in results]))
    default = results[1]['summary']
    passed = (median >= control['summary']['sharpe'] and default['sharpe'] >= control['summary']['sharpe']
              and default['mdd_pct'] >= control['summary']['mdd_pct'])
    record = {'development_gate_passed':passed, 'median_sharpe':median, 'control':control, 'runs':results,
              'next_step':'FROZEN_DEFAULT_RETROSPECTIVE_VALIDATION' if passed else 'REJECT_NO_FUTURE_EVALUATION'}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
    print(json.dumps({'passed':passed, 'median_sharpe':median, 'control':control['summary'],
                      'runs':[x['summary'] for x in results]}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['panel','fred','output']:
        parser.add_argument('--'+name,required=True)
    args = parser.parse_args()
    develop(args.panel,args.fred,args.output)
