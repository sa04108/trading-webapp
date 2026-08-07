/**
 * 종목 마스터 이벤트 종류 — 서버 `eventType` 과 화면 태그 문구를 한곳에서 잇는다.
 *
 * 목록의 태그와 종류 드롭다운이 같은 표를 봐야 "주식수 변경" 태그를 보고 고른
 * 항목이 실제로 그 태그만 걸러낸다. 화면 두 곳이 각자 문구를 들고 있으면 종류가
 * 하나 늘 때 한쪽만 고쳐도 눈치채기 어렵다.
 */
const EVENT_TYPE_LABELS = {
  LISTED: '신규상장',
  DELISTED: '상장폐지',
  MARKET_MOVED: '시장이전',
  SHARES_CHANGED: '주식수 변경',
  NAME_CHANGED: '종목명 변경',
  TYPE_CHANGED: '유형 변경',
} as const;

export type SymbolMasterEventType = keyof typeof EVENT_TYPE_LABELS;
export type EventTypeFilter = 'ALL' | SymbolMasterEventType;

export function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType as SymbolMasterEventType] ?? eventType;
}

export interface EventTypeFilterOption {
  readonly value: EventTypeFilter;
  readonly label: string;
}

/**
 * 드롭다운 항목 — 지금 불러온 이벤트에 있는 종류만 넣지 않고 아는 종류를 모두 넣는다.
 * 날짜를 옮길 때마다 항목이 생겼다 사라지면 방금 고른 종류가 말없이 전체 보기로
 * 돌아가 버린다.
 */
export const EVENT_TYPE_FILTER_OPTIONS: readonly EventTypeFilterOption[] = [
  { value: 'ALL', label: '전체 보기' },
  ...(Object.keys(EVENT_TYPE_LABELS) as SymbolMasterEventType[]).map((value) => ({
    value,
    label: EVENT_TYPE_LABELS[value],
  })),
];

export function filterEventsByType<T extends { readonly eventType: string }>(
  events: readonly T[],
  filter: EventTypeFilter | string,
): readonly T[] {
  if (filter === 'ALL') return events;
  return events.filter((event) => event.eventType === filter);
}
