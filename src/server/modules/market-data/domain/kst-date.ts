/** KST 달력일은 timezone 라이브러리 없이 고정 오프셋으로 계산한다. */
const KST_OFFSET_MS = 540 * 60 * 1000;
const DAY_MS = 86_400_000;

export const KRX_DATA_EPOCH = '2010-01-04';

export function kstDateOf(tsMs: number): string {
  return new Date(tsMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function kstHourOf(tsMs: number): number {
  return new Date(tsMs + KST_OFFSET_MS).getUTCHours();
}

export function addCalendarDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** ISO 달력일이 토·일요일인지 본다. KRX 거래일 후보를 거를 때 사용한다. */
export function isWeekendDate(isoDate: string): boolean {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function isoToBasDd(isoDate: string): string {
  return isoDate.replaceAll('-', '');
}

export function basDdToIso(basDd: string): string {
  return `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`;
}

/** 그 KST 달력일의 마지막 ms — 공시 as-of 컷오프(≤ 기준일)에 쓴다 */
export function kstEndOfDayMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) - KST_OFFSET_MS + DAY_MS - 1;
}
