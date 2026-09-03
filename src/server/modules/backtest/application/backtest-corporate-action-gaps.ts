import type {
  CorporateActionCoverageStore,
  CorporateActionGapDetail,
} from '../../facts/application/corporate-action-coverage.js';
import {
  CORPORATE_ACTION_ALIGNMENT_WINDOW,
  type SharesChange,
} from '../../facts/domain/corporate-action-effective-date.js';
import { addCalendarDays } from '../../market-data/domain/kst-date.js';

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
  'getGapYears' | 'getGapDetails'
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
        periodKey: '-',
        reason: '상세 사유가 저장되지 않은 자본변동 gap',
        severity: 'BLOCKING' as const,
      })),
    ]),
  );
}

/**
 * DART gap 중 KRX 상장주식수 변경과 날짜상 연결되는 것만 매매 대상 제외 사유로 고른다.
 *
 * 상장 전 기준 주식수나 사건 없는 연도의 빈 앵커는 KRX 변경이 없으므로 제외된다.
 * 반대로 일자·발행형태가 깨진 행 주변에 실제 KRX 변경이 있으면 보정 비율을 만들
 * 근거가 부족한 것이므로 해당 종목을 제외한다. KRX 비율만으로 유상/무상을 추측하지 않는다.
 */
export function findRelevantCorporateActionGaps(
  detailsBySymbol: ReadonlyMap<string, readonly CorporateActionGapDetail[]>,
  sharesChanges: readonly SharesChange[],
  window: CorporateActionGapWindow,
): RelevantCorporateActionGap[] {
  const changesBySymbol = new Map<string, SharesChange[]>();
  for (const change of sharesChanges) {
    if (change.effectiveDate < window.executionFrom || change.effectiveDate > window.executionTo) {
      continue;
    }
    const changes = changesBySymbol.get(change.shortCode) ?? [];
    changes.push(change);
    changesBySymbol.set(change.shortCode, changes);
  }
  const rawFromYear = Number(window.rawFrom.slice(0, 4));
  const rawToYear = Number(window.rawTo.slice(0, 4));
  const relevant: RelevantCorporateActionGap[] = [];

  for (const [symbol, details] of detailsBySymbol) {
    const changes = changesBySymbol.get(symbol) ?? [];
    if (changes.length === 0) continue;
    for (const detail of details) {
      if (detail.severity !== 'BLOCKING') continue;
      const rawDate = normalizedExactDate(detail.periodKey);
      if (rawDate === null) {
        if (detail.year < rawFromYear || detail.year > rawToYear) continue;
      } else {
        if (rawDate < window.rawFrom || rawDate > window.rawTo) continue;
        const firstMatchingChange = addCalendarDays(
          rawDate,
          -CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays,
        );
        const lastMatchingChange = addCalendarDays(
          rawDate,
          CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays,
        );
        if (!changes.some((change) => (
          change.effectiveDate >= firstMatchingChange
          && change.effectiveDate <= lastMatchingChange
        ))) continue;
      }
      relevant.push({ symbol, ...detail });
    }
  }
  return relevant.sort((left, right) => (
    left.symbol.localeCompare(right.symbol)
    || left.year - right.year
    || left.periodKey.localeCompare(right.periodKey)
    || left.reason.localeCompare(right.reason)
  ));
}

function normalizedExactDate(periodKey: string): string | null {
  const match = /^(\d{4})[-.](\d{2})[-.](\d{2})$/.exec(periodKey.trim());
  if (!match) return null;
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}
