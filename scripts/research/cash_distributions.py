"""확정되지 않은 분배금 가설의 권리·미수금·지급 현금만 별도로 추적한다."""
from datetime import date
import math


PROVISIONAL = 'UNVERIFIED_DISTRIBUTION_SCENARIO'


def validate_scenario(scenario, days, symbols, start, end):
    """가설의 범위·주당 단위·출처를 명시하지 않은 입력은 거부한다."""
    if scenario.get('status') != PROVISIONAL:
        raise ValueError('분배금 가설의 미검증 상태를 명시해야 합니다')
    if scenario.get('amount_unit') != 'USD_PER_ACTUAL_EX_DATE_SHARE':
        raise ValueError('분배금은 배당락일 실제 주식 한 주의 달러 단위여야 합니다')
    if not scenario.get('coverage_from', '9999') <= start <= end <= scenario.get('coverage_to', ''):
        raise ValueError('분배금 가설의 자료 범위 밖입니다')
    if set(scenario.get('covered_symbols', [])) != set(symbols):
        raise ValueError('분배금 가설의 자산 범위가 다릅니다')
    events, seen = [], set()
    calendar = set(days)
    for raw in scenario.get('events', []):
        event = dict(raw)
        ex, pay = event['ex_date'], event['pay_date']
        date.fromisoformat(ex); date.fromisoformat(pay)
        key = (event['symbol'], ex)
        amount = event['amount_usd']
        if key in seen or event['symbol'] not in symbols:
            raise ValueError('중복되거나 범위 밖인 분배금 종목·배당락일')
        if not isinstance(amount, (int, float)) or not math.isfinite(amount) or amount <= 0:
            raise ValueError('분배금 금액은 유한한 양수여야 합니다')
        if pay < ex or ex not in calendar or not event.get('source_refs'):
            raise ValueError('분배금의 거래일·지급일·출처 오류')
        if not scenario['coverage_from'] <= ex <= scenario['coverage_to']:
            raise ValueError('분배금 이벤트가 자료 범위 밖입니다')
        seen.add(key)
        if start <= ex <= end:
            events.append(event)
    return sorted(events, key=lambda x:(x['ex_date'], x['symbol']))


class CashDistributions:
    def __init__(self, scenario, days, symbols, start, end):
        self.events = validate_scenario(scenario, days, symbols, start, end)
        self.symbols = list(symbols)
        self.pending, self.entries = [], []
        self.accrued = self.paid = 0.

    def accrue_before_orders(self, day, shares):
        """당일 분할 후 기존 보유분에만 권리를 부여하고 시가 매수에는 부여하지 않는다."""
        for event in self.events:
            if event['ex_date'] != day:
                continue
            held = float(shares[self.symbols.index(event['symbol'])])
            amount = held * event['amount_usd']
            entry = {**event, 'entitled_shares':held, 'receivable_usd':amount, 'cash_posted_date':None}
            self.entries.append(entry)
            self.pending.append(entry)
            self.accrued += amount

    def settle_after_orders(self, day):
        """지급일의 시가 주문 뒤 현금화하며 그 이전에는 매수 재원으로 쓰지 않는다."""
        amount = 0.
        remaining = []
        for entry in self.pending:
            if entry['pay_date'] <= day:
                amount += entry['receivable_usd']
                entry['cash_posted_date'] = day
            else:
                remaining.append(entry)
        self.pending = remaining
        self.paid += amount
        return amount

    @property
    def receivable(self):
        return sum(x['receivable_usd'] for x in self.pending)

    def report(self):
        return {'status':PROVISIONAL, 'eligible_event_count':len(self.events),
                'accrued_usd':self.accrued, 'paid_usd':self.paid,
                'ending_receivable_usd':self.receivable, 'entries':self.entries,
                'cash_timing':'지급일 또는 이후 첫 거래일의 시가 주문 이후 현금화',
                'taxes':'EXCLUDED', 'coverage_certified':False}
