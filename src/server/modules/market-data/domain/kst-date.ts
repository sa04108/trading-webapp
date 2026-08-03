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

export function isoToBasDd(isoDate: string): string {
  return isoDate.replaceAll('-', '');
}

export function basDdToIso(basDd: string): string {
  return `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`;
}
