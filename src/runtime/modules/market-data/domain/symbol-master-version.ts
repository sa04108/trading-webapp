import type { SymbolMasterEntry } from './symbol-master.js';

/** SCD Type 2 반개구간 [validFromDate, validToDate). null 종료일은 +∞ 다. */
export interface SymbolMasterVersionSegment {
  readonly validFromDate: string;
  readonly validToDate: string | null;
  readonly entry: SymbolMasterEntry;
  readonly recordedAtMs: number;
}

const ENTRY_FIELDS = [
  'standardCode',
  'shortCode',
  'name',
  'market',
  'sharesOutstanding',
  'instrumentType',
  'listedDate',
] as const satisfies ReadonlyArray<keyof SymbolMasterEntry>;

/** 저장하는 종목 상태 전체가 같은지 비교한다. */
export function sameSymbolMasterEntry(
  left: SymbolMasterEntry | undefined,
  right: SymbolMasterEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return ENTRY_FIELDS.every((field) => left[field] === right[field]);
}

function endsBeforeOrAt(segment: SymbolMasterVersionSegment, date: string): boolean {
  return segment.validToDate !== null && segment.validToDate <= date;
}

function startsAfterOrAt(segment: SymbolMasterVersionSegment, date: string | null): boolean {
  return date !== null && segment.validFromDate >= date;
}

function normalizeTimeline(
  segments: readonly SymbolMasterVersionSegment[],
): SymbolMasterVersionSegment[] {
  const sorted = [...segments]
    .filter((segment) => segment.validToDate === null || segment.validFromDate < segment.validToDate)
    .sort((a, b) => a.validFromDate.localeCompare(b.validFromDate));
  const normalized: SymbolMasterVersionSegment[] = [];

  for (const segment of sorted) {
    const previous = normalized.at(-1);
    if (previous !== undefined) {
      if (previous.validToDate === null || previous.validToDate > segment.validFromDate) {
        throw new Error(`종목 버전 구간이 겹친다: ${segment.entry.standardCode}`);
      }
      if (
        previous.validToDate === segment.validFromDate
        && sameSymbolMasterEntry(previous.entry, segment.entry)
      ) {
        normalized[normalized.length - 1] = {
          ...previous,
          validToDate: segment.validToDate,
          recordedAtMs: Math.min(previous.recordedAtMs, segment.recordedAtMs),
        };
        continue;
      }
    }
    normalized.push(segment);
  }
  return normalized;
}

/**
 * 종목 하나의 전체 버전 타임라인에서 [fromDate, toDate) 구간만
 * desired 상태로 덮어쓴다. desired=undefined 면 해당 구간에서 종목이 존재하지
 * 않는다. 구간 앞·뒤의 기존 상태는 보존하고, 인접한 동일 상태는 하나로
 * 합쳐 과거 날짜를 하루씩 더해도 행이 늘지 않게 한다.
 */
export function overlayVersionTimeline(
  existing: readonly SymbolMasterVersionSegment[],
  fromDate: string,
  toDate: string | null,
  desired: SymbolMasterEntry | undefined,
  recordedAtMs: number,
): SymbolMasterVersionSegment[] {
  if (toDate !== null && fromDate >= toDate) {
    throw new Error(`잘못된 종목 버전 덮어쓰기 구간: ${fromDate} ~ ${toDate}`);
  }

  const pieces: SymbolMasterVersionSegment[] = [];
  for (const segment of existing) {
    if (endsBeforeOrAt(segment, fromDate) || startsAfterOrAt(segment, toDate)) {
      pieces.push(segment);
      continue;
    }

    if (segment.validFromDate < fromDate) {
      pieces.push({ ...segment, validToDate: fromDate });
    }
    if (
      toDate !== null
      && (segment.validToDate === null || segment.validToDate > toDate)
    ) {
      pieces.push({ ...segment, validFromDate: toDate });
    }
  }

  if (desired !== undefined) {
    pieces.push({
      validFromDate: fromDate,
      validToDate: toDate,
      entry: desired,
      recordedAtMs,
    });
  }

  return normalizeTimeline(pieces);
}
