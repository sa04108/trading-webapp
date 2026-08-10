import type { Market } from './candle.js';
import { getSessionForMarket } from './exchange-session.js';

const MS_PER_MINUTE = 60_000;

/** 재무 수집 연도 범위를 뽑을 때 보는 커버리지 필드만 */
export interface FactYearRangeCoverageRow {
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
  readonly barCount: number;
}

/**
 * 백테스트 기간과 선행 공시 분기 수를 DART 사업연도 범위로 올림한다.
 * DART는 분기가 아니라 사업연도 단위로 조회하므로 1~4분기는 1년, 5~8분기는 2년을
 * 기간 시작 연도 앞에 더한다.
 */
export function derivePreparationFactYearRange(
  period: { readonly from: string; readonly to: string },
  lookbackQuarters: number,
): { fromYear: number; toYear: number } {
  const fromYear = Number(period.from.slice(0, 4));
  const toYear = Number(period.to.slice(0, 4));
  const warmupYears = Math.ceil(Math.max(0, lookbackQuarters) / 4);
  return { fromYear: fromYear - warmupYears, toYear };
}

/**
 * 봉 커버리지에서 재무 수집 연도 범위를 뽑는다.
 *
 * 백테스트는 봉이 있는 구간만 돌므로 재무도 그 구간만 있으면 충분하다 — 봉이 2019년
 * 부터인데 2015년 재무를 긁는 것은 낭비다. 상장일을 쓰지 않는(쓸 수 없는) 이유이기도
 * 하다: 이 시스템에는 상장일 정보가 없고, 있어도 봉보다 앞선 구간은 쓸 데가 없다.
 *
 * 연도는 **거래소 현지 시각** 으로 자른다. UTC 로 자르면 KST 1월 1일 09:00 개장 봉이
 * 전년도로 밀려 그 해 재무를 수집 대상에서 빠뜨린다.
 *
 * 봉이 하나도 없으면 null — 호출부가 재무 단계를 건너뛰고 사유를 남긴다.
 */
export function deriveFactYearRange(
  coverage: readonly FactYearRangeCoverageRow[],
  market: Market,
): { fromYear: number; toYear: number } | null {
  const offsetMs = getSessionForMarket(market).utcOffsetMinutes * MS_PER_MINUTE;

  let fromYear: number | null = null;
  let toYear: number | null = null;
  for (const row of coverage) {
    if (row.barCount <= 0) continue;
    if (row.firstTsMs !== null) {
      const year = localYear(row.firstTsMs, offsetMs);
      if (fromYear === null || year < fromYear) fromYear = year;
    }
    if (row.lastTsMs !== null) {
      const year = localYear(row.lastTsMs, offsetMs);
      if (toYear === null || year > toYear) toYear = year;
    }
  }

  if (fromYear === null || toYear === null) return null;
  return { fromYear, toYear };
}

function localYear(tsMs: number, offsetMs: number): number {
  return new Date(tsMs + offsetMs).getUTCFullYear();
}
