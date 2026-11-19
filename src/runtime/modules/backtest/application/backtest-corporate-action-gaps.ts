import type { ActionGapPeriod } from "../domain/action-gap.js";
import type {
  CorporateActionCoverageStore,
  CorporateActionGapDetail,
} from "../../facts/application/corporate-action-coverage.js";
import {
  CORPORATE_ACTION_ALIGNMENT_WINDOW,
  type SharesChange,
} from "../../facts/domain/corporate-action-effective-date.js";
import { addCalendarDays, isWeekendDate } from "../../market-data/domain/kst-date.js";

export interface RelevantCorporateActionGap extends CorporateActionGapDetail {
  readonly symbol: string;
}

export interface CorporateActionGapWindow {
  /** KRX 주식수 변경이 실제 수익률·백테스트 실행에 영향을 주는 구간 */
  readonly executionFrom: string;
  readonly executionTo: string;
  /** DART 기준일이 정렬 창 역투영으로 관련될 수 있는 구간 */
  readonly rawFrom: string;
  readonly rawTo: string;
}

type GapCoverageReader = Pick<
  CorporateActionCoverageStore,
  "getGapYears" | "getGapDetails"
>;

/**
 * 새 상세 컬럼이 없는 구버전·테스트 대역도 연도 gap을 잃지 않게 보수적인 상세로
 * 승격한다. 실제 저장소는 원문 날짜와 DART 파서 사유를 돌려준다.
 */
export function readCorporateActionGapDetails(
  coverage: GapCoverageReader,
  symbols: readonly string[],
): ReadonlyMap<string, readonly CorporateActionGapDetail[]> {
  const detailed = coverage.getGapDetails?.(symbols);
  if (detailed !== undefined) return detailed;
  return new Map(
    [...coverage.getGapYears(symbols)].map(([symbol, years]) => [
      symbol,
      years.map((year) => ({
        year,
        periodKey: "-",
        reason: "상세 사유가 저장되지 않은 자본변동 gap",
        severity: "BLOCKING" as const,
      })),
    ]),
  );
}

/** DECLINE 순위 계산에 사용되는 날짜에도 매매와 동일한 자본변동 경계를 적용한다. */
export function findRelevantCorporateActionGaps(
  detailsBySymbol: ReadonlyMap<string, readonly CorporateActionGapDetail[]>,
  sharesChanges: readonly SharesChange[],
  window: CorporateActionGapWindow,
): RelevantCorporateActionGap[] {
  if (window.executionFrom > window.executionTo) return [];
  const selected = new Map([...detailsBySymbol].map(([symbol, rows]) => [symbol, rows.filter(row => {
    const raw = normalizedExactDate(row.periodKey);
    return !raw || (raw >= window.rawFrom && raw <= window.rawTo);
  })]));
  const years = new Map([...selected].map(([symbol, rows]) => [symbol, [...new Set(rows.map(row => row.year))]]));
  const relevant: RelevantCorporateActionGap[] = [];
  corporateActionGapPeriods({ getGapYears: () => years, getGapDetails: () => selected }, [...selected.keys()], [], sharesChanges,
    true, { from: window.executionFrom, to: window.executionTo }, [], gap => relevant.push(gap));
  return relevant.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.year - b.year || a.periodKey.localeCompare(b.periodKey) || a.reason.localeCompare(b.reason));
}

function normalizedExactDate(periodKey: string): string | null {
  const match = /^(\d{4})[-.](\d{2})[-.](\d{2})$/.exec(periodKey.trim());
  if (!match) return null;
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}

type MasterCoverage = boolean | readonly { startDate: string; endDate: string }[];

/** KRX가 확인된 날짜는 실제 주식수 변경일에만 경계를 두고, 미확인 날짜에는 공시의 정렬 가능 구간을 보존한다. */
export function corporateActionGapPeriods(
  coverage: GapCoverageReader,
  symbols: readonly string[],
  unaligned: readonly { symbol: string; periodKey: string }[],
  sharesChanges: readonly SharesChange[],
  verified: MasterCoverage,
  window: { from: string; to: string },
  selectionGaps: readonly RelevantCorporateActionGap[] = [],
  onRelevant?: (gap: RelevantCorporateActionGap) => void,
): Map<string, ActionGapPeriod[]> {
  const result = new Map<string, ActionGapPeriod[]>();
  function add(symbol: string, from: string, to: string, year: number) {
    if (from > window.to || to < window.from || from > to) return false;
    const period = { from: Date.parse(from), to: Date.parse(to), year };
    const periods = result.get(symbol) ?? [];
    if (!periods.some(item => item.year === year && item.from === period.from && item.to === period.to)) periods.push(period);
    result.set(symbol, periods);
    return true;
  }
  const details = readCorporateActionGapDetails(coverage, symbols);
  const gapYears = coverage.getGapYears(symbols);
  const evidence = typeof verified === "boolean" ? [] : verified;
  const changes = new Map<string, SharesChange[]>();
  for (const change of sharesChanges) {
    const rows = changes.get(change.shortCode) ?? [];
    rows.push(change);
    changes.set(change.shortCode, rows);
  }
  // KRX가 토·일요일에 주식수를 발표하지 않아 생긴 빈 구간은 미확인 거래일이 아니다.
  function addUnverified(symbol: string, from: string, to: string, year: number) {
    if (from > window.to || to < window.from || from > to) return false;
    while (isWeekendDate(from)) from = addCalendarDays(from, 1);
    while (isWeekendDate(to)) to = addCalendarDays(to, -1);
    return add(symbol, from, to, year);
  }
  function record(gap: RelevantCorporateActionGap) {
    if (gap.severity !== "BLOCKING") return;
    const { symbol, year } = gap;
    const raw = normalizedExactDate(gap.periodKey);
    let relevant = false;
    if (!raw) {
      relevant = add(symbol, `${year}-01-01`, `${year}-12-31`, year);
    } else {
      const from = addCalendarDays(raw, -CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays);
      const to = addCalendarDays(raw, CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays);
      for (const row of changes.get(symbol) ?? []) {
        if (row.effectiveDate >= from && row.effectiveDate <= to && add(symbol, row.effectiveDate, row.effectiveDate, year)) relevant = true;
      }
      if (verified !== true) {
        let cursor = from;
        for (const range of evidence) {
          if (range.endDate < cursor) continue;
          if (range.startDate > to) break;
          if (addUnverified(symbol, cursor, addCalendarDays(range.startDate, -1), year)) relevant = true;
          cursor = addCalendarDays(range.endDate, 1);
          if (cursor > to) break;
        }
        if (addUnverified(symbol, cursor, to, year)) relevant = true;
      }
    }
    if (relevant) onRelevant?.(gap);
  }
  for (const symbol of symbols) {
    for (const year of gapYears.get(symbol) ?? []) {
      const gaps = details.get(symbol)?.filter(gap => gap.year === year) ?? [];
      if (!gaps.length) record({ symbol, year, periodKey: "-", severity: "BLOCKING", reason: "상세 사유가 저장되지 않은 자본변동 gap" });
      for (const gap of gaps) record({ symbol, ...gap });
    }
  }
  for (const gap of selectionGaps) if (symbols.includes(gap.symbol)) record(gap);
  for (const action of unaligned) {
    // 비율 자체를 KRX 변경에 연결할 수 없으므로 임의의 주식수 변경일에 귀속시키지 않는다.
    const raw = normalizedExactDate(action.periodKey);
    if (!raw) continue;
    const year = Number(raw.slice(0, 4));
    if (add(action.symbol, addCalendarDays(raw, -CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays),
      addCalendarDays(raw, CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays), year)) {
      onRelevant?.({ symbol: action.symbol, year, periodKey: action.periodKey, reason: "KRX 상장주식수 변경일과 정렬할 수 없는 자본변동", severity: "BLOCKING" });
    }
  }
  return result;
}
