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
