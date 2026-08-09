import type { KrxExclusionReason } from './krx-filter-policy.js';
import type { KrxMarket } from './krx-universe-types.js';

export type SymbolMasterInstrumentType = 'COMMON_STOCK' | KrxExclusionReason;

export interface SymbolMasterEntry {
  readonly standardCode: string;
  readonly shortCode: string;
  readonly name: string;
  readonly market: KrxMarket;
  readonly sharesOutstanding: string;
  readonly instrumentType: SymbolMasterInstrumentType;
  readonly listedDate: string | null;
}

export type UniverseState = ReadonlyMap<string, SymbolMasterEntry>; // key = standardCode

export type SymbolMasterEventType =
  | 'LISTED' | 'DELISTED' | 'MARKET_MOVED'
  | 'SHARES_CHANGED' | 'NAME_CHANGED' | 'TYPE_CHANGED'
  | 'SHORT_CODE_CHANGED' | 'LISTED_DATE_CHANGED';

export interface SymbolMasterEventDraft {
  readonly effectiveDate: string;
  readonly standardCode: string;
  readonly eventType: SymbolMasterEventType;
  readonly oldValue: string | null; // JSON 문자열
  readonly newValue: string | null;
  readonly observedSpanStart: string;
}

/** 필드 이벤트 매핑 — 순회 순서가 곧 이벤트 생성 순서다 */
const FIELD_EVENTS = [
  ['market', 'MARKET_MOVED'],
  ['sharesOutstanding', 'SHARES_CHANGED'],
  ['name', 'NAME_CHANGED'],
  ['instrumentType', 'TYPE_CHANGED'],
  ['shortCode', 'SHORT_CODE_CHANGED'],
  ['listedDate', 'LISTED_DATE_CHANGED'],
] as const satisfies ReadonlyArray<readonly [keyof SymbolMasterEntry, SymbolMasterEventType]>;

export function diffUniverse(
  prev: UniverseState,
  next: UniverseState,
  meta: { effectiveDate: string; observedSpanStart: string },
): SymbolMasterEventDraft[] {
  const events: SymbolMasterEventDraft[] = [];
  const base = { effectiveDate: meta.effectiveDate, observedSpanStart: meta.observedSpanStart };

  for (const [code, nextEntry] of next) {
    const prevEntry = prev.get(code);
    if (!prevEntry) {
      events.push({ ...base, standardCode: code, eventType: 'LISTED',
        oldValue: null, newValue: JSON.stringify(nextEntry) });
      continue;
    }
    for (const [field, eventType] of FIELD_EVENTS) {
      if (prevEntry[field] !== nextEntry[field]) {
        events.push({ ...base, standardCode: code, eventType,
          oldValue: JSON.stringify(prevEntry[field]),
          newValue: JSON.stringify(nextEntry[field]) });
      }
    }
  }
  for (const [code, prevEntry] of prev) {
    if (!next.has(code)) {
      events.push({ ...base, standardCode: code, eventType: 'DELISTED',
        oldValue: JSON.stringify(prevEntry), newValue: null });
    }
  }
  return events;
}

const FIELD_BY_EVENT = {
  MARKET_MOVED: 'market',
  SHARES_CHANGED: 'sharesOutstanding',
  NAME_CHANGED: 'name',
  TYPE_CHANGED: 'instrumentType',
  SHORT_CODE_CHANGED: 'shortCode',
  LISTED_DATE_CHANGED: 'listedDate',
} as const;

/** 0012 이행 시 legacy 이벤트 체인을 읽기 위한 순방향 재생기. 신규 수집에는 쓰지 않는다. */
export function applyEventsForward(
  state: UniverseState, events: readonly SymbolMasterEventDraft[],
): UniverseState {
  const next = new Map(state);
  for (const ev of events) {
    if (ev.eventType === 'LISTED') {
      next.set(ev.standardCode, JSON.parse(ev.newValue!) as SymbolMasterEntry);
    } else if (ev.eventType === 'DELISTED') {
      next.delete(ev.standardCode);
    } else {
      const current = next.get(ev.standardCode);
      if (!current) continue; // 갭 수집이 만든 중복 이벤트 — 절대값이라 건너뛰어도 안전하다
      const field = FIELD_BY_EVENT[ev.eventType];
      next.set(ev.standardCode, { ...current, [field]: JSON.parse(ev.newValue!) });
    }
  }
  return next;
}

/** 0012 이행 시 legacy 이벤트 체인을 읽기 위한 역방향 재생기. 신규 수집에는 쓰지 않는다. */
export function applyEventsBackward(
  state: UniverseState, events: readonly SymbolMasterEventDraft[],
): UniverseState {
  const next = new Map(state);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.eventType === 'LISTED') {
      next.delete(ev.standardCode);
    } else if (ev.eventType === 'DELISTED') {
      next.set(ev.standardCode, JSON.parse(ev.oldValue!) as SymbolMasterEntry);
    } else {
      const current = next.get(ev.standardCode);
      if (!current) continue;
      const field = FIELD_BY_EVENT[ev.eventType];
      next.set(ev.standardCode, { ...current, [field]: JSON.parse(ev.oldValue!) });
    }
  }
  return next;
}
