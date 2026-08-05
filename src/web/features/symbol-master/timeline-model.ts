// 이 모듈은 DOM 을 쓰지 않고 별칭(@/) import 도 쓰지 않는다 — tests/unit 이 이 파일을
// 직접 import 해 tsconfig.server.json 의 NodeNext 프로그램에 편입되기 때문이다
// (src/web/features/backtests/krx-selection.ts 와 같은 이유).

/** 커버리지 타임라인의 한 구간 — 전체 [0,100] 을 이어 붙이면 빈틈이 없다 */
export interface TimelineSegment {
  readonly startPct: number;
  readonly endPct: number;
  readonly covered: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' 를 UTC 자정 기준 밀리초로 바꾼다 — 로컬 타임존에 흔들리지 않게 한다 */
function dateToUtcMs(date: string): number {
  const parts = date.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return Date.UTC(year, month - 1, day);
}

/** UTC 밀리초를 'YYYY-MM-DD' 로 바꾼다 — dateToUtcMs 의 역연산 */
function utcMsToDate(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const clampPct = (pct: number): number => Math.min(100, Math.max(0, pct));

/**
 * ISO 날짜를 [rangeStart, rangeEnd] 구간 안 % 위치로 바꾼다.
 *
 * rangeStart==rangeEnd 면 구간 길이가 0이라 나눗셈이 정의되지 않는다 — 이때는
 * 항상 0을 돌려준다(0으로 나누는 대신 방어).
 */
export function dateToPct(rangeStart: string, rangeEnd: string, date: string): number {
  const startMs = dateToUtcMs(rangeStart);
  const endMs = dateToUtcMs(rangeEnd);
  if (startMs === endMs) return 0;

  const pct = ((dateToUtcMs(date) - startMs) / (endMs - startMs)) * 100;
  return clampPct(pct);
}

/**
 * [rangeStart, rangeEnd] 구간 안 % 위치를 ISO 날짜로 바꾼다.
 *
 * 밀리초 선형 보간 결과가 하루 중간에 떨어질 수 있어 일 단위로 내림한다 — 슬라이더
 * 값은 항상 실제 거래일(자정 기준)을 가리켜야 하기 때문이다. rangeStart==rangeEnd
 * 면 구간 길이가 0이라 항상 rangeStart 를 돌려준다.
 */
export function pctToDate(rangeStart: string, rangeEnd: string, pct: number): string {
  const startMs = dateToUtcMs(rangeStart);
  const endMs = dateToUtcMs(rangeEnd);
  if (startMs === endMs) return rangeStart;

  const clamped = clampPct(pct);
  const ms = startMs + ((endMs - startMs) * clamped) / 100;
  const flooredMs = Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
  return utcMsToDate(flooredMs);
}

/**
 * [rangeStart, rangeEnd] 전체 구간 대비 coverage 를 % 세그먼트로 바꾼다.
 *
 * covered 입력이 정렬되어 있다고 가정하지 않는다 — 서버 응답 순서를 신뢰할 근거가
 * 없으므로 항상 시작일 기준으로 다시 정렬한 뒤 처리한다. covered 구간 사이·양 끝의
 * 빈틈은 covered:false 세그먼트로 채워 [0,100] 전체를 빈틈없이 잇는다.
 */
export function buildTimelineSegments(
  rangeStart: string,
  rangeEnd: string,
  covered: readonly { startDate: string; endDate: string }[],
): TimelineSegment[] {
  const sorted = covered
    .slice()
    .sort((a, b) => dateToUtcMs(a.startDate) - dateToUtcMs(b.startDate));

  const segments: TimelineSegment[] = [];
  let cursorPct = 0;
  for (const range of sorted) {
    const startPct = dateToPct(rangeStart, rangeEnd, range.startDate);
    const endPct = dateToPct(rangeStart, rangeEnd, range.endDate);
    if (startPct > cursorPct) {
      segments.push({ startPct: cursorPct, endPct: startPct, covered: false });
    }
    segments.push({ startPct, endPct, covered: true });
    cursorPct = endPct;
  }
  if (cursorPct < 100) {
    segments.push({ startPct: cursorPct, endPct: 100, covered: false });
  }

  // covered 가 하나도 없으면 위 루프가 아무것도 남기지 않는다 — 전체 구간을 미커버
  // 하나로 표시한다.
  if (segments.length === 0) {
    segments.push({ startPct: 0, endPct: 100, covered: false });
  }

  return segments;
}
