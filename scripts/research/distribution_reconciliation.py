"""분배금 가설을 운용사 총수익과 대조하고 고정 후보에 미치는 영향만 진단한다."""
import argparse
import csv
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import numpy as np

from diversified_backtest import DiversifiedParameters, DiversifiedResearch
from diversified_validation import START, END, initial_dollars, currency_result


SEC_SOURCE = 'https://www.sec.gov/Archives/edgar/data/1174610/000168386324008327/f39882d1.htm'
PERFORMANCE_SOURCE = 'https://accounts.profunds.com/etfdata/etf_performance.csv'


def exact_index(days, day):
    i = int(np.searchsorted(days, day))
    if i >= len(days) or days[i] != day:
        raise ValueError(f'필수 기준일 누락: {day}')
    return i


def issuer_ten_year(path):
    """종목·기간·기준일을 고정하고 다른 달의 최신 값으로 바꾸지 않는다."""
    with Path(path).open() as stream:
        rows = [x for x in csv.DictReader(stream) if x['Fund Symbol']=='QLD'
                and x['Return Type']=='NAV' and x['Data Period']=='MONTH'
                and x['Return Effective Date']=='2026-08-31 00:00:00.000']
    if len(rows) != 1:
        raise ValueError('고정한 QLD 공식 NAV 수익 기준일·행 누락')
    value = float(rows[0]['10-Year Return'])
    if not np.isfinite(value) or value <= -100:
        raise ValueError('공식 총수익 값 오류')
    return value


def nav_reconciliation(research, scenario, start, end, reported, years):
    """배당락일 NAV 재투자 대용 계산이며 지급일 현금 전략과 구분한다."""
    nav_days, nav = research.data['nav_days'], research.data['nav_close'][:,0]
    price_growth = float(nav[exact_index(nav_days,end)] / nav[exact_index(nav_days,start)])
    ratios = np.ones(3)
    events = []
    for event in scenario['events']:
        if not start < event['ex_date'] <= end:
            continue
        i = exact_index(research.days,event['ex_date'])
        factor = float(research.data['future_factor'][i,0])
        amount, step = event['amount_usd']/factor, event['amount_rounding_step_usd']/factor
        if event['symbol']!='QLD' or not np.isfinite([amount,step]).all() or not 0 <= step < amount:
            raise ValueError('분배금 대조의 종목·정밀도 오류')
        at_ex = float(nav[exact_index(nav_days,event['ex_date'])])
        ratios *= 1 + np.array([amount-step,amount,amount+step])/at_ex
        events.append({'date':event['ex_date'],'adjusted_dividend_usd':amount,'nav_usd':at_ex})
    cumulative = 100*(price_growth*ratios-1)
    annualized = 100*((price_growth*ratios)**(1/years)-1)
    rounding = [reported-.005,reported+.005]
    compatible = bool(annualized[0] <= rounding[1] and annualized[-1] >= rounding[0])
    return {'from_close':start,'to_close':end,'years':years,'price_return_pct':100*(price_growth-1),
            'reinvestment_growth_ratio':float(ratios[1]),'cumulative_return_pct':float(cumulative[1]),
            'annualized_return_pct':float(annualized[1]),'reported_annualized_return_pct':reported,
            'reported_rounding_interval_pct':rounding,'input_decimal_sensitivity_annualized_pct':annualized[[0,-1]].tolist(),
            'compatible_with_reported_rounding':compatible,'events':events,
            'note':'주당 배당 표기 정밀도 한 단위 양방향 감도. 통계 신뢰구간·이벤트 완전성 인증이 아님.'}


def replay_distributions(research, result, scenario):
    """분배금 처리 객체를 재사용하지 않고 체결·원문 이벤트에서 일별 장부를 재생한다."""
    cash, shares = result['summary']['initial_usd'], np.zeros(2)
    claims, entries, errors = [], [], []
    min_cash, paid_total = cash, 0.
    for day, expected in zip(result['dates'],result['equity']):
        i = exact_index(research.days,day)
        shares *= research.data['split'][i]
        for event in scenario['events']:
            if event['ex_date']==day:
                j = list(research.symbols).index(event['symbol'])
                entry = {**event,'entitled_shares':float(shares[j]),'receivable_usd':float(shares[j]*event['amount_usd']), 'cash_posted_date':None}
                claims.append(entry); entries.append(entry)
        for trade in result['trades']:
            if trade['date']!=day:
                continue
            j = list(research.symbols).index(trade['symbol'])
            change = trade['quantity']*(1 if trade['side']=='buy' else -1)
            cash -= change*trade['price']+trade['commission']
            shares[j] += change
            min_cash = min(min_cash,cash)
            if cash < -1e-6 or np.any(shares<0):
                raise AssertionError('분배금 장부 현금·보유 제약 실패')
        unpaid = []
        for entry in claims:
            if entry['pay_date']<=day:
                cash += entry['receivable_usd']; paid_total += entry['receivable_usd']
                entry['cash_posted_date'] = day
            else:
                unpaid.append(entry)
        claims = unpaid
        actual = cash+shares@research.data['close'][i]+sum(x['receivable_usd'] for x in claims)
        errors.append(abs(actual-expected))
    audit = result['summary']['distribution_audit']
    if max(errors)>1e-6 or entries!=audit['entries'] or abs(paid_total-audit['paid_usd'])>1e-6:
        raise AssertionError('분배금 장부 독립 재생 실패')
    return {'days_checked':len(errors),'max_equity_error_usd':max(errors),'minimum_cash_usd':float(min_cash),
            'paid_usd':paid_total,'ending_receivable_usd':sum(x['receivable_usd'] for x in claims)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['panel','fred','scenarios','performance','prior-validation','output']:
        parser.add_argument('--'+name,required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise FileExistsError('기존 분배금 감사를 덮어쓰지 않습니다')
    research = DiversifiedResearch(args.panel,args.fred)
    initial, _ = initial_dollars(research,START)
    p = DiversifiedParameters()
    base = research.run(p,START,END,initial)
    old = json.loads(Path(args.prior_validation).read_text())
    if base['equity']!=old['base']['equity'] or base['trades']!=old['base']['trades']:
        raise AssertionError('기존 가격수익 결과가 바뀌었습니다')
    official = issuer_ten_year(args.performance)
    scenarios = []
    for name in ['quarantined_20','reported_21']:
        path = Path(args.scenarios)/f'{name}.json'
        scenario = json.loads(path.read_text())
        result = research.run(p,START,END,initial,distribution_scenario=scenario)
        checks = [nav_reconciliation(research,scenario,'2016-08-31','2026-08-31',official,10),
                  nav_reconciliation(research,scenario,'2022-12-30','2023-12-29',117.08,1)]
        scenarios.append({'name':name,'input':scenario,'input_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                          'issuer_checks':checks,'issuer_consistent':all(x['compatible_with_reported_rounding'] for x in checks),
                          'usd':result['summary'],'krw':currency_result(research,result)['summary'],
                          'ledger_replay':replay_distributions(research,result,scenario),
                          'equity':result['equity'],'trades':result['trades'],
                          'strict_usd_risk_gate':result['summary']['sharpe']>=1 and result['summary']['mdd_pct']>=-35})
    bounds = []
    for prior in old['sensitivity_runs']:
        if prior['strict_error'] is None:
            continue
        params = DiversifiedParameters(**prior['usd']['parameters'])
        result = research.run(replace(params,invalid_open_policy='quote_worst'),START,END,prior['usd']['initial_usd'])
        affected = [t for t in result['trades'] if t['date']=='2021-05-05' and t['symbol']=='GLD']
        bounds.append({'kind':prior['kind'],'value':prior['value'],'affected_trades':affected,
                       'return_delta_pp':result['summary']['total_return_pct']-prior['usd']['total_return_pct'],
                       'sharpe_delta':result['summary']['sharpe']-prior['usd']['sharpe'],
                       'status':'OBSERVED_QUOTE_ADVERSE_BOUND_NOT_VERIFIED_OPEN'})
    result = {'status':'DATA_AUDIT_NOT_CERTIFIED_TOTAL_RETURN_OR_STRATEGY_ACCEPTANCE','dates':base['dates'],
              'price_only_regression':{'equity_days_exact':len(base['equity']),'trades_exact':len(base['trades'])},
              'scenarios':scenarios,'quote_bound_audit':bounds,
              'references':{'ten_year':PERFORMANCE_SOURCE,'calendar_2023':SEC_SOURCE},
              'source_hashes':{'performance':hashlib.sha256(Path(args.performance).read_bytes()).hexdigest(),
                                'prior_validation':hashlib.sha256(Path(args.prior_validation).read_bytes()).hexdigest(),
                                'fred':hashlib.sha256(Path(args.fred).read_bytes()).hexdigest(),**research.audit['source_hashes']},
              'code_hashes':{name:hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest() for name in
                             ['cash_distributions.py','distribution_reconciliation.py','diversified_backtest.py','diversified_validation.py']},
              'decision':'가설 일치 여부와 무관하게 원문 분배금 전체 인증·달러 위험 관문·위기 및 사후 선택 한계는 남음'}
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x') as stream:
        json.dump(result,stream,ensure_ascii=False,indent=2,allow_nan=False)
    print(json.dumps({'price_only_regression':result['price_only_regression'],'scenarios':[
        {'name':s['name'],'issuer_consistent':s['issuer_consistent'],'usd':{k:s['usd'][k] for k in ['total_return_pct','sharpe','mdd_pct']},
         'ledger':s['ledger_replay'],'strict_usd_risk_gate':s['strict_usd_risk_gate']} for s in scenarios],
         'quote_bounds':{'cases':len(bounds),'max_return_change_pp':max(abs(b['return_delta_pp']) for b in bounds)}},ensure_ascii=False))


if __name__=='__main__':
    main()
