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
  | 'SHARES_CHANGED' | 'NAME_CHANGED' | 'TYPE_CHANGED';

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
} as const;

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

/** ISO 날짜(YYYY-MM-DD)에서 분기 라벨을 뽑는다 — '2023-04-03' → '2023-Q2' */
export function quarterOf(iso: string): string {
  const year = iso.slice(0, 4);
  const month = Number(iso.slice(5, 7));
  const quarter = Math.ceil(month / 3);
  return `${year}-Q${quarter}`;
}

/** 값이 다른 필드만 기록한다 — mismatch 는 로그에 그대로 실리므로 코드 목록 위주로 유지한다 */
export interface UniverseMismatch {
  /** 실측(KRX)에는 있지만 재구성에는 없는 종목코드 */
  readonly added: readonly string[];
  /** 재구성에는 있지만 실측에는 없는 종목코드 */
  readonly removed: readonly string[];
  readonly changed: ReadonlyArray<{
    readonly code: string;
    readonly field: keyof SymbolMasterEntry;
    readonly reconstructed: unknown;
    readonly actual: unknown;
  }>;
}

const COMPARE_FIELDS = [
  'shortCode', 'name', 'market', 'sharesOutstanding', 'instrumentType', 'listedDate',
] as const satisfies ReadonlyArray<keyof SymbolMasterEntry>;

/**
 * 이벤트 체인으로 재구성한 유니버스와 KRX 실측을 비교한다. 이벤트 저장이 오염돼
 * 재구성이 실측과 어긋났는지 분기 체크포인트 시점마다 검증하는 데 쓴다.
 * 일치하면 undefined — 호출부가 이 값으로 검증 통과 여부를 가른다.
 */
export function findUniverseMismatch(
  reconstructed: UniverseState,
  actual: UniverseState,
): UniverseMismatch | undefined {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: UniverseMismatch['changed'][number][] = [];

  for (const [code, actualEntry] of actual) {
    const reconstructedEntry = reconstructed.get(code);
    if (!reconstructedEntry) {
      added.push(code);
      continue;
    }
    for (const field of COMPARE_FIELDS) {
      if (reconstructedEntry[field] !== actualEntry[field]) {
        changed.push({
          code, field,
          reconstructed: reconstructedEntry[field],
          actual: actualEntry[field],
        });
      }
    }
  }
  for (const code of reconstructed.keys()) {
    if (!actual.has(code)) removed.push(code);
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) return undefined;
  return { added, removed, changed };
}

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
