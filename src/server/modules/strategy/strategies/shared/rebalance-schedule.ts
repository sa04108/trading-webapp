import { KR_SESSION, toLocalTime } from '../../../market-data/domain/exchange-session.js';

const MS_PER_DAY = 86_400_000;

/**
 * 거래소 현지(KST) 기준 'YYYY-MM'. UTC 월을 쓰면 매월 1일 장 시작 봉(KST 09:00 =
 * UTC 00:00)은 괜찮지만 월말 야간 봉이 다음 달로 새어 리밸런스가 어긋난다.
 */
export function localMonthKey(tsMs: number): string {
  const { dayIndex } = toLocalTime(tsMs, KR_SESSION);
  const date = new Date(dayIndex * MS_PER_DAY);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthsBetween(fromKey: string, toKey: string): number {
  const [fromYear, fromMonth] = fromKey.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = toKey.split('-').map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

/**
 * 리밸런스 봉 판정. 최초 실행(lastKey === null)은 항상 참이다.
 * 부등호가 `>=` 인 이유: 휴장·데이터 공백으로 정확한 달을 건너뛰어도 놓치지 않는다.
 */
export function isRebalanceDue(
  lastKey: string | null,
  currentKey: string,
  rebalanceMonths: number,
): boolean {
  if (lastKey === null) return true;
  return monthsBetween(lastKey, currentKey) >= rebalanceMonths;
}
