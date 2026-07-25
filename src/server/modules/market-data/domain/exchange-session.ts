/**
 * 거래소 정규 세션 정의. MVP 는 고정 UTC 오프셋만 지원한다 (KR: KST, DST 없음).
 * 미국 시장 DST 는 MVP 한계로 결과 화면에 명시한다 (docs/DECISIONS.md D-006).
 */
export interface ExchangeSession {
  /** 거래소 현지 시간의 UTC 오프셋 (분). KST = +540 */
  readonly utcOffsetMinutes: number;
  /** 세션 시작: 현지 자정 기준 분. 09:00 = 540 */
  readonly openMinutes: number;
  /** 세션 종료(미포함): 현지 자정 기준 분. 15:30 = 930 */
  readonly closeMinutes: number;
}

export const KR_SESSION: ExchangeSession = {
  utcOffsetMinutes: 540,
  openMinutes: 9 * 60,
  closeMinutes: 15 * 60 + 30,
};

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export interface LocalTime {
  /** 현지 기준 일 인덱스 (epoch 일수) */
  readonly dayIndex: number;
  /** 현지 자정 기준 경과 분 */
  readonly minuteOfDay: number;
  /** 현지 요일 0=일요일 ... 6=토요일 */
  readonly dayOfWeek: number;
}

export function toLocalTime(tsMs: number, session: ExchangeSession): LocalTime {
  const localMs = tsMs + session.utcOffsetMinutes * MS_PER_MINUTE;
  const dayIndex = Math.floor(localMs / MS_PER_DAY);
  const minuteOfDay = Math.floor((localMs - dayIndex * MS_PER_DAY) / MS_PER_MINUTE);
  // 1970-01-01 은 목요일(4)
  const dayOfWeek = ((dayIndex % 7) + 7 + 4) % 7;
  return { dayIndex, minuteOfDay, dayOfWeek };
}

export function isWithinSession(tsMs: number, session: ExchangeSession): boolean {
  const local = toLocalTime(tsMs, session);
  if (local.dayOfWeek === 0 || local.dayOfWeek === 6) return false;
  return local.minuteOfDay >= session.openMinutes && local.minuteOfDay < session.closeMinutes;
}

/** 현지 (dayIndex, minuteOfDay) → UTC epoch ms */
export function fromLocalTime(
  dayIndex: number,
  minuteOfDay: number,
  session: ExchangeSession,
): number {
  return dayIndex * MS_PER_DAY + minuteOfDay * MS_PER_MINUTE - session.utcOffsetMinutes * MS_PER_MINUTE;
}

/** 세션 내 시간봉 시작 분 목록 (마지막 봉은 부분 봉일 수 있다) */
export function hourlyBucketStarts(session: ExchangeSession): number[] {
  const starts: number[] = [];
  for (let minute = session.openMinutes; minute < session.closeMinutes; minute += 60) {
    starts.push(minute);
  }
  return starts;
}
