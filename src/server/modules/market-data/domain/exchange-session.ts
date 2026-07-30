import type { Market } from './candle.js';

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

export class UnsupportedMarketSessionError extends Error {
  constructor(market: Market) {
    super(`${market} 시장의 세션은 아직 지원되지 않습니다 (DST 미지원, docs/DECISIONS.md D-006)`);
    this.name = 'UnsupportedMarketSessionError';
  }
}

/**
 * 시장 → 세션. **"이 시장을 지원하는가" 의 단일 출처다.**
 *
 * 이전에는 지원 여부가 `getSessionForMarket` 이 던진다는 사실 안에 암묵적으로만
 * 있었다 — 화면이 그걸 물어볼 방법이 없어서 UI 에 시장 목록을 따로 박아야 했고,
 * 세션이 추가되는 날 화면만 낡은 채로 남는다.
 */
const SESSIONS: Partial<Record<Market, ExchangeSession>> = { KR: KR_SESSION };

/** 시장별 세션 해석. 세션이 정의되지 않은 시장은 명시적으로 거부한다. */
export function getSessionForMarket(market: Market): ExchangeSession {
  const session = SESSIONS[market];
  if (!session) throw new UnsupportedMarketSessionError(market);
  return session;
}

/** 세션이 정의된 시장인지 — 데이터셋 생성·집계·coverage 가능 여부와 같은 질문이다 */
export function hasMarketSession(market: Market): boolean {
  return SESSIONS[market] !== undefined;
}

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

/** 현지 일 인덱스 → 요일 (0=일요일). 1970-01-01 은 목요일(4). */
export function dayOfWeekFromDayIndex(dayIndex: number): number {
  return ((dayIndex % 7) + 7 + 4) % 7;
}

export function toLocalTime(tsMs: number, session: ExchangeSession): LocalTime {
  const localMs = tsMs + session.utcOffsetMinutes * MS_PER_MINUTE;
  const dayIndex = Math.floor(localMs / MS_PER_DAY);
  const minuteOfDay = Math.floor((localMs - dayIndex * MS_PER_DAY) / MS_PER_MINUTE);
  return { dayIndex, minuteOfDay, dayOfWeek: dayOfWeekFromDayIndex(dayIndex) };
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
