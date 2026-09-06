"""고정 40:60 후보를 통화·비용·체결·과거 위기에서 다시 검증한다."""
import argparse
from dataclasses import asdict, replace
from datetime import date
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from diversified_backtest import DiversifiedParameters, DiversifiedResearch
from etf_robustness import block_intervals
from research_backtest import metrics


START, END = '2016-08-28', '2026-08-28'
CAPITAL_KRW, FX_SPREAD = 1e8, .001


def asof(series, days):
    """해당 날짜까지 관측된 마지막 값만 평가에 사용한다."""
    result = series.reindex(sorted(set(series.index) | set(days))).ffill().reindex(days).to_numpy()
    if not np.isfinite(result).all() or (result <= 0).any():
        raise ValueError('필수 과거 관측값 누락')
    return result


def kr_rates(research, days):
    """월 단기금리는 발표 시차를 보수적으로 두 달로 둔다."""
    raw = research.macro['IR3TIB01KRM156N']
    shifted = raw.copy()
    shifted.index = [(pd.Timestamp(d) + pd.DateOffset(months=2)).strftime('%Y-%m-%d') for d in raw.index]
    return asof(shifted, days) / 100


def initial_dollars(research, start, capital=CAPITAL_KRW, spread=FX_SPREAD):
    first = int(np.searchsorted(research.days, start))
    if first <= 0 or first >= len(research.days):
        raise ValueError('환전 기준일의 이전 거래일이 없습니다')
    prior_close_day = str(research.days[first-1])
    fx = float(asof(research.macro['DEXKOUS'], [prior_close_day])[0])
    return capital / (fx * (1 + spread)), fx


def currency_result(research, result, capital=CAPITAL_KRW, spread=FX_SPREAD, fx_lag=0):
    days = np.asarray(result['dates'])
    valuation_days = days
    if fx_lag:
        index = np.searchsorted(research.days, days)
        valuation_days = research.days[index - fx_lag]
    fx = asof(research.macro['DEXKOUS'], valuation_days)
    equity = np.asarray(result['equity']) * fx * (1 - spread)
    summary = metrics(equity, days, kr_rates(research, days), capital)
    elapsed = (date.fromisoformat(result['summary']['requested_to']) - date.fromisoformat(result['summary']['requested_from'])).days
    summary['cagr_pct'] = 100 * ((equity[-1] / capital) ** (365.25 / elapsed) - 1)
    summary.update({'currency':'KRW', 'initial_krw':capital, 'fx_spread_each_way':spread,
                    'fx_valuation_lag_sessions':fx_lag, 'taxes':'EXCLUDED'})
    return {'summary':summary, 'equity':equity.tolist()}


def benchmark(research, result, capital=CAPITAL_KRW, spread=FX_SPREAD):
    days = np.asarray(result['dates'])
    before = float(research.macro['NASDAQ100'].loc[lambda s:s.index < days[0]].iloc[-1])
    ndx = asof(research.macro['NASDAQ100'], days)
    initial = result['summary']['initial_usd']
    equity = initial * ndx / before
    indices = np.searchsorted(research.days, days)
    usd = metrics(equity, days, research.rf[indices], initial)
    copy = {**result, 'equity':equity.tolist()}
    krw = currency_result(research, copy, capital, spread)
    return {'usd':usd, 'krw':krw['summary'], 'equity_usd':equity.tolist(), 'equity_krw':krw['equity'],
            'definition':'나스닥100 가격지수, 배당 없음, 지수 거래비용 없음, 원화에는 같은 환전 비용 적용'}


def replay_ledger(research, result):
    """주문 목표 계산과 별도로 체결 장부만 재생해 매일 잔고를 대조한다."""
    cash = result['summary']['initial_usd']
    shares = np.zeros(2)
    by_day = {}
    for trade in result['trades']:
        by_day.setdefault(trade['date'], []).append(trade)
    errors, min_cash, min_shares = [], cash, 0.
    for day, expected in zip(result['dates'], result['equity']):
        i = np.searchsorted(research.days, day)
        shares *= research.data['split'][i]
        for trade in by_day.get(day, []):
            j = list(research.symbols).index(trade['symbol'])
            sign = 1 if trade['side'] == 'buy' else -1
            shares[j] += sign * trade['quantity']
            cash -= sign * trade['quantity'] * trade['price'] + trade['commission']
        actual = cash + shares @ research.data['close'][i]
        errors.append(abs(actual - expected))
        min_cash, min_shares = min(min_cash, cash), min(min_shares, shares.min())
    if max(errors) > 1e-6 or min_cash < -1e-6 or min_shares < 0:
        raise AssertionError('체결 장부 독립 재생 실패')
    return {'days_checked':len(errors), 'max_equity_error_usd':max(errors),
            'minimum_cash_usd':float(min_cash), 'minimum_shares':float(min_shares)}


def nav_proxy(research):
    """실제 ETF NAV를 다음 날 가격 대용치로 쓰는 별도 위기 진단이다."""
    clone = DiversifiedResearch.__new__(DiversifiedResearch)
    clone.days = research.data['nav_days']
    clone.symbols, clone.macro, clone.audit = research.symbols, research.macro, research.audit
    factor, split = np.ones((len(clone.days), 2)), np.ones((len(clone.days), 2))
    for event in research.audit['split_events']:
        factor[clone.days < event['date'], 0] *= event['ratio']
        split[clone.days == event['date'], 0] = event['ratio']
    signal = research.data['nav_close']
    raw = signal * factor
    clone.data = {key:raw.copy() for key in ['open', 'high', 'low', 'close']}
    clone.data.update({'signal_close':signal, 'split':split, 'volume':np.full(raw.shape, 1e12),
                       'valid_open':np.ones(raw.shape, dtype=bool)})
    clone.returns = np.vstack([np.zeros(2), signal[1:] / signal[:-1] - 1])
    rates = clone.macro['DTB3']
    clone.rf = rates.reindex(sorted(set(rates.index) | set(clone.days))).ffill().reindex(clone.days).shift(1).fillna(0).to_numpy() / 100
    return clone


def drawdown_dates(equity, days, initial):
    values = np.r_[initial, equity]
    running = np.maximum.accumulate(values)
    trough = int(np.argmin(values / running - 1))
    peak = int(np.argmax(values[:trough+1]))
    recovered = np.flatnonzero(values[trough+1:] >= values[peak])
    labels = ['INITIAL'] + list(days)
    return {'peak':labels[peak], 'trough':labels[trough],
            'recovered':labels[trough+1+int(recovered[0])] if len(recovered) else None}


def load_issuer(path):
    """보조 벤치마크의 기준일과 단위를 본 실험에 고정한다."""
    issuer = json.loads(Path(path).read_text())
    if issuer.get('effectiveDate') != '2026-08-31' or issuer.get('ticker') != 'QQQ' or issuer.get('currencyCode') != 'USD':
        raise ValueError('보존한 Invesco 기준일·종목·통화와 다릅니다')
    entries = issuer.get('cumulativePerformance', [])
    required = [x for x in entries if x.get('label') == 'marketPrice' or (x.get('label') == 'benchmark' and x.get('benchmarkOrder') == 10)]
    if len(required) != 2 or not all(isinstance(x.get('y10'), (float,int)) for x in required):
        raise ValueError('공식 10년 총수익 비교값 누락')
    return issuer


def run_validation(research, issuer_path):
    issuer = load_issuer(issuer_path)
    p = DiversifiedParameters()
    initial, fx_start = initial_dollars(research, START)
    base = research.run(p, START, END, initial)
    krw = currency_result(research, base)
    ndx = benchmark(research, base)
    cases = []
    cases += [('equity_weight', float(x), replace(p, equity_weight=float(x)), CAPITAL_KRW) for x in np.linspace(.32, .48, 9)]
    cases += [('cost_multiplier', x, replace(p, cost_multiplier=x), CAPITAL_KRW) for x in [1, 2, 4, 10]]
    cases += [('execution_delay', x, replace(p, delay=x), CAPITAL_KRW) for x in [1, 2, 3]]
    cases += [('signal_offset', x, replace(p, signal_offset=x), CAPITAL_KRW) for x in [-3, -1, 0, 1, 3]]
    cases += [('rebalance_months', x, replace(p, rebalance_months=x), CAPITAL_KRW) for x in [1, 3, 6]]
    cases += [('cash_buffer', x, replace(p, cash_buffer=x), CAPITAL_KRW) for x in [0, .01, .03]]
    cases += [('order_seed', x, replace(p, seed=x), CAPITAL_KRW) for x in range(30)]
    cases += [('execution_noise_seed', x, replace(p, seed=x, random_execution=True), CAPITAL_KRW) for x in range(100)]
    cases += [('initial_krw', x, p, x) for x in [1e6, 1e7, 1e8, 1e9]]
    sensitivities = []
    for kind, value, params, capital in cases:
        dollars, _ = initial_dollars(research, START, capital)
        error = None
        try:
            result = research.run(params, START, END, dollars)
        except ValueError as exc:
            if '주문 시가 오류' not in str(exc):
                raise
            error = str(exc)
            result = research.run(replace(params, invalid_open_policy='range_worst'), START, END, dollars)
        local = currency_result(research, result, capital)
        sensitivities.append({'kind':kind, 'value':value, 'usd':result['summary'], 'krw':local['summary'],
                              'strict_error':error, 'execution_status':'ADVERSE_BAR_BOUND' if error else 'ACTUAL_MARKET_OPEN'})
    ranges = {}
    for kind in sorted(set(x['kind'] for x in sensitivities)):
        group = [x for x in sensitivities if x['kind'] == kind]
        ranges[kind] = {'runs':len(group), 'adverse_bar_bound_runs':sum(x['strict_error'] is not None for x in group)}
        for currency in ['usd', 'krw']:
            ranges[kind][currency] = {m:{'min':min(x[currency][m] for x in group),
                                             'median':float(np.median([x[currency][m] for x in group])),
                                             'max':max(x[currency][m] for x in group)}
                                      for m in ['total_return_pct', 'sharpe', 'mdd_pct']}
    for currency, entry in [('usd', base), ('krw', krw)]:
        capital = initial if currency == 'usd' else CAPITAL_KRW
        entry['drawdown'] = drawdown_dates(entry['equity'], base['dates'], capital)
    indices = np.searchsorted(research.days, base['dates'])
    usd_returns = np.asarray(base['equity']) / np.r_[initial, base['equity'][:-1]] - 1
    krw_returns = np.asarray(krw['equity']) / np.r_[CAPITAL_KRW, krw['equity'][:-1]] - 1
    ndx_usd = np.asarray(ndx['equity_usd']) / np.r_[initial, ndx['equity_usd'][:-1]] - 1
    ndx_krw = np.asarray(ndx['equity_krw']) / np.r_[CAPITAL_KRW, ndx['equity_krw'][:-1]] - 1
    annual = []
    for year in sorted(set(d[:4] for d in base['dates'])):
        mask = np.array([d.startswith(year) for d in base['dates']])
        annual.append({'year':year, 'sessions':int(mask.sum()), **{name:100*float(np.expm1(np.log1p(values[mask]).sum()))
                      for name, values in [('strategy_usd', usd_returns), ('ndx_usd', ndx_usd), ('strategy_krw', krw_returns), ('ndx_krw', ndx_krw)]}})
    intervals = {currency:[block_intervals(a, b, rf, length) for length in [21, 63, 126]]
                 for currency, a, b, rf in [('usd', usd_returns, ndx_usd, research.rf[indices]),
                                             ('krw', krw_returns, ndx_krw, kr_rates(research, base['dates']))]}
    rolling = []
    for years in [3, 5]:
        records = []
        for i, day in enumerate(base['dates']):
            if i+1 < len(base['dates']) and day[:7] == base['dates'][i+1][:7]:
                continue
            start = (pd.Timestamp(day)-pd.DateOffset(years=years)).strftime('%Y-%m-%d')
            before = int(np.searchsorted(base['dates'], start, side='right')-1)
            if before < 0:
                continue
            values = {name:100*(array[i]/array[before]-1) for name, array in [('strategy_usd', np.asarray(base['equity'])),
                       ('ndx_usd', np.asarray(ndx['equity_usd'])), ('strategy_krw', np.asarray(krw['equity'])), ('ndx_krw', np.asarray(ndx['equity_krw']))]}
            records.append({'from':base['dates'][before], 'to':day, **values})
        rolling.append({'years':years, 'windows':records, 'positive_usd_fraction':float(np.mean([x['strategy_usd']>0 for x in records])),
                        'outperform_ndx_fraction':float(np.mean([x['strategy_usd']>x['ndx_usd'] for x in records]))})
    historical = []
    for start, end, label in [('2011-10-01', END, 'full_actual_market'), ('2011-10-01', '2021-10-01', 'earlier_ten_year'),
                              ('2012-08-28', '2022-08-28', 'earlier_ten_year'), ('2013-08-28', '2023-08-28', 'earlier_ten_year'),
                              ('2014-08-28', '2024-08-28', 'earlier_ten_year'), ('2015-08-28', '2025-08-28', 'earlier_ten_year')]:
        dollars, _ = initial_dollars(research, start)
        result = research.run(p, start, end, dollars)
        historical.append({'label':label, 'usd':result['summary'], 'krw':currency_result(research, result)['summary'],
                           'ndx':{k:v for k,v in benchmark(research, result).items() if not k.startswith('equity')}})
    proxy = nav_proxy(research)
    crises = []
    for start, end in [('2007-07-01', '2009-03-31'), ('2007-07-01', '2010-07-08')]:
        dollars, _ = initial_dollars(proxy, start)
        result = proxy.run(p, start, end, dollars)
        crises.append({'status':'NEXT_DAY_NAV_PROXY_NOT_MARKET_EXECUTION', 'usd':result['summary'],
                       'krw':currency_result(proxy, result)['summary'],
                       'ndx':{k:v for k,v in benchmark(proxy, result).items() if not k.startswith('equity')}})
    secondary = research.run(p, '2016-09-01', '2026-08-31', 100000.)
    secondary['summary']['funded_at_close'] = '2016-08-31'
    secondary['summary']['cagr_pct'] = 100 * ((secondary['equity'][-1] / 100000.) ** (365.25 / (date(2026,8,31)-date(2016,8,31)).days) - 1)
    fx_cases = []
    for spread in [0, .001, .003, .005]:
        dollars, _ = initial_dollars(research, START, spread=spread)
        result = research.run(p, START, END, dollars)
        fx_cases.append(currency_result(research, result, spread=spread)['summary'])
    position = np.asarray(base['weights'])
    return {'status':'RETROSPECTIVE_CANDIDATE_REQUIRES_RISK_AND_REGIME_JUDGMENT', 'base':base, 'krw':krw, 'ndx':ndx,
            'initial_fx':fx_start, 'ledger_replay':replay_ledger(research, base),
            'sensitivity_ranges':ranges, 'sensitivity_runs':sensitivities, 'bootstrap':intervals, 'annual':annual,
            'rolling':rolling, 'historical':historical, 'nav_crises':crises, 'fx_cost_sensitivity':fx_cases,
            'fx_previous_session_valuation':currency_result(research, base, fx_lag=1)['summary'],
            'exposure':{'qld_weight_min':float(position[:,0].min()), 'qld_weight_max':float(position[:,0].max()),
                         'lookthrough_notional_mean':float(np.mean(2*position[:,0]+position[:,1])),
                         'lookthrough_notional_max':float(np.max(2*position[:,0]+position[:,1]))},
            'issuer_comparison':{'strategy':secondary['summary'], 'issuer_raw':issuer,
                 'source':'https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/QQQ/performance/standard?idType=ticker&performanceSubType=cumulative&productType=ETF',
                 'note':'2016-08-31 종가 이후 첫 시가에 투자. 후보는 분배금 제외, 공식 벤치마크는 배당 재투자. 본 검증 기간은 변경하지 않음'},
            'audit':research.audit, 'provenance':{'fred_sha256':None, 'issuer_sha256':hashlib.sha256(Path(issuer_path).read_bytes()).hexdigest()},
            'limitations':['모든 추가 실험은 회고 검증이며 새 독립 홀드아웃이 아님', '분배금과 투자자 세금 제외',
                           '원화 환율과 미국 종가의 일중 시점 차이', 'GLD 오류 시가를 만난 민감도는 실제 체결이 아닌 불리한 봉 범위 경계',
                           'NAV 위기 진단은 당시 시가·호가·거래량 체결 복원이 아님']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['panel', 'fred', 'issuer', 'output']:
        parser.add_argument('--'+name, required=True)
    args = parser.parse_args()
    path = Path(args.output)
    if path.exists():
        raise FileExistsError('기존 전체 검증을 덮어쓰지 않습니다')
    research = DiversifiedResearch(args.panel, args.fred)
    result = run_validation(research, args.issuer)
    result['provenance']['fred_sha256'] = hashlib.sha256(Path(args.fred).read_bytes()).hexdigest()
    result['provenance']['code_hashes'] = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob('*.py')}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    print(json.dumps({k:result[k] for k in ['status', 'sensitivity_ranges', 'ledger_replay', 'historical', 'nav_crises', 'exposure']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
