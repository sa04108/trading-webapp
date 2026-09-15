import type { KrxExclusionReason } from './krx-filter-policy.js';
import type { KrxMarket } from './krx-universe-types.js';

export type SymbolMasterInstrumentType =
  | 'COMMON_STOCK'
  | KrxExclusionReason
  /** KRX가 행은 줬지만 종목 분류 필드를 해석할 수 없어 매매 후보에서 제외한 상태. */
  | 'UNKNOWN_CLASSIFICATION'
  /** 일별매매에는 존재하지만 그날 기본정보 행이 없어 직전 identity만 보존한 상태. */
  | 'MISSING_BASE_INFO'
  /** 보통주로 분류됐지만 상장주식수가 비어 자본변동 정합성을 확인할 수 없는 상태. */
  | 'MISSING_SHARES';

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
