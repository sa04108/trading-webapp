import { useEffect, useMemo, useState } from 'react';
import { PageSizeInput, Pagination } from '@/components/pagination';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { parsePageSize } from '@/lib/page-size';
import { pageWindow } from '@/lib/pagination';
import { useSymbolMasterEvents } from './use-symbol-master';
import {
  EVENT_TYPE_FILTER_OPTIONS,
  eventTypeLabel,
  filterEventsByType,
  type EventTypeFilter,
} from './event-types';
import { addDays } from './timeline-model';
import type { SymbolMasterEventDto } from '../../../shared/schemas/symbol-master.js';

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

  const [typeFilter, setTypeFilter] = useState<EventTypeFilter>('ALL');
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState('10');
  const pageSize = parsePageSize(pageSizeText, 10);

  // 날짜가 바뀌면 다른 구간의 이벤트다 — 보던 페이지 번호를 물려주면 안 된다.
  // 종류 선택은 유지한다: "주식수 변경만 보며 날짜를 훑는" 게 이 사이드바의 쓰임이다.
  useEffect(() => {
    setPage(0);
  }, [date]);

  const filtered = useMemo(() => filterEventsByType(events, typeFilter), [events, typeFilter]);
  const { pageCount, currentPage, from: sliceFrom, to: sliceTo } = pageWindow(
    filtered.length,
    pageSize,
    page,
  );
  const visible = filtered.slice(sliceFrom, sliceTo);
  const filterLabel =
    EVENT_TYPE_FILTER_OPTIONS.find((option) => option.value === typeFilter)?.label ?? '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">최근 이벤트</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Select
            value={typeFilter}
            onValueChange={(value) => {
              setTypeFilter(value as EventTypeFilter);
              setPage(0);
            }}
          >
            <SelectTrigger className="h-8 w-32" aria-label="이벤트 종류 필터">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_TYPE_FILTER_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <PageSizeInput
            value={pageSizeText}
            label="최근 이벤트 페이지당 표시 수"
            unit="건"
            onChange={(nextValue) => {
              setPageSizeText(nextValue);
              setPage(0);
            }}
          />
        </div>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {from} ~ {to} 변경 없음
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {from} ~ {to} {filterLabel} 없음
          </p>
        ) : (
          <>
            <ul className="divide-y">
              {visible.map((event) => (
                <EventRow key={event.id} event={event} symbolNames={symbolNames} />
              ))}
            </ul>
            <Pagination
              ariaLabel="최근 이벤트 페이지 이동"
              currentPage={currentPage}
              pageCount={pageCount}
              // 사이드바가 320px 라 번호 버튼 3개가 상한이다 — 그 이상은 카드 밖으로 넘친다
              maxPageNumbers={3}
              total={{ count: filtered.length, unit: '건' }}
              onPageChange={setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
