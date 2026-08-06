import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSymbolMasterEvents } from './use-symbol-master';
import { addDays } from './timeline-model';
import type { SymbolMasterEventDto } from '../../../shared/schemas/symbol-master.js';

const EVENT_TYPE_LABELS: Record<string, string> = {
  LISTED: '신규상장',
  DELISTED: '상장폐지',
  MARKET_MOVED: '시장이전',
  SHARES_CHANGED: '주식수 변경',
  NAME_CHANGED: '종목명 변경',
  TYPE_CHANGED: '유형 변경',
};

function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? eventType;
}

/**
 * 이벤트가 관측된 시점의 근사 여부를 판단한다.
 *
 * `observedSpanStart` 는 서버가 실제로 그 변화를 확인한 관측 구간의 시작이다.
 * 통상적인 경우 effectiveDate 바로 전 영업일에 관측되므로 그 값과 같으면 "정확한"
 * 관측으로 본다. 그보다 더 과거라면 그 사이 어느 날 바뀌었는지 정확히 모른다는
 * 뜻이라 관측 구간 시작일을 그대로 보여준다.
 *
 * 거래 캘린더(공휴일)는 이 화면에 없다 — 주말만 건너뛰는 근사치다. 실제 공휴일과
 * 어긋나도 "근사"라는 사실 자체는 달라지지 않는다.
 */
function previousBusinessDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const day = d.getUTCDay();
  if (day === 0) d.setUTCDate(d.getUTCDate() - 2); // 일요일 → 금요일
  else if (day === 6) d.setUTCDate(d.getUTCDate() - 1); // 토요일 → 금요일
  return d.toISOString().slice(0, 10);
}

function EventRow({
  event,
  symbolNames,
}: {
  event: SymbolMasterEventDto;
  symbolNames: ReadonlyMap<string, string>;
}) {
  const name = symbolNames.get(event.standardCode) ?? event.standardCode;
  const expectedSpanStart = previousBusinessDay(event.effectiveDate);
  const approximate = event.observedSpanStart !== expectedSpanStart;

  return (
    <li className="space-y-0.5 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{name}</span>
        <Badge variant="outline">{eventTypeLabel(event.eventType)}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {event.effectiveDate}
        {approximate ? ` (${event.observedSpanStart} 이후)` : ''}
      </p>
      {event.oldValue !== null || event.newValue !== null ? (
        <p className="text-xs text-muted-foreground">
          {event.oldValue ?? '-'} → {event.newValue ?? '-'}
        </p>
      ) : null}
    </li>
  );
}

/** 선택 날짜 근처 종목 마스터 변경 — 표가 왜 이렇게 보이는지(신규상장·상폐 등)를 옆에서 설명한다 */
export function EventsSidebar({
  date,
  symbolNames,
}: {
  date: string;
  symbolNames: ReadonlyMap<string, string>;
}) {
  const from = addDays(date, -14);
  const to = addDays(date, 14);
  const { events, isLoading } = useSymbolMasterEvents(from, to);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">근처 변경 목록</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {from} ~ {to} 변경 없음
          </p>
        ) : (
          <ul className="divide-y">
            {events.map((event) => (
              <EventRow key={event.id} event={event} symbolNames={symbolNames} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
