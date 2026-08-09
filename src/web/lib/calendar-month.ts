// 이 모듈은 DOM 을 쓰지 않고 별칭(@/) import 도 쓰지 않는다 — tests/unit 이 이 파일을
// 직접 import 해 tsconfig.server.json 의 NodeNext 프로그램에 편입되기 때문이다
// (src/web/features/symbol-master/timeline-model.ts 와 같은 이유).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 달력 한 칸 — 해당 달 밖의 칸(앞뒤 여백)은 outside 로 구분한다 */
export interface CalendarCell {
  /** 'YYYY-MM-DD' */
  readonly date: string;
  readonly day: number;
  /** 표시 중인 달이 아니라 앞뒤 달에서 끌어온 칸 */
  readonly outside: boolean;
}

/** 'YYYY-MM' 를 연·월 숫자로 쪼갠다 */
function parseMonth(month: string): { year: number; monthIndex: number } {
  const parts = month.split('-');
  return { year: Number(parts[0]), monthIndex: Number(parts[1]) - 1 };
}

function toIso(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

/** 'YYYY-MM-DD' 에서 달('YYYY-MM')만 떼어낸다 */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** 'YYYY-MM' 에 개월 수를 더한다(음수면 뺀다) */
export function addMonths(month: string, delta: number): string {
  const { year, monthIndex } = parseMonth(month);
  const total = year * 12 + monthIndex + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = String((total % 12) + 1).padStart(2, '0');
  return `${nextYear}-${nextMonth}`;
}

/** 화면에 쓰는 달 표기 — '2026년 8월' */
export function formatMonth(month: string): string {
  const { year, monthIndex } = parseMonth(month);
  return `${year}년 ${monthIndex + 1}월`;
}

/**
 * 'YYYY-MM' 한 달을 일요일 시작 7칸 격자로 편다.
 *
 * 앞뒤 여백을 이웃 달 날짜로 채우는 이유: 빈 칸으로 두면 월 경계 근처 날짜를 고를 때
 * 달을 넘겨야 하는데, 슬라이더 대신 달력을 여는 목적 자체가 그 왕복을 없애는 것이다.
 * 격자 길이는 6주(42칸)로 고정한다 — 달마다 높이가 바뀌면 다음 달 버튼이 발밑에서
 * 움직여 연속으로 누르기 어렵다.
 *
 * 모든 계산은 UTC 자정 기준이다. 로컬 타임존으로 하면 UTC+9 에서 하루가 밀린다.
 */
export function buildMonthGrid(month: string): CalendarCell[] {
  const { year, monthIndex } = parseMonth(month);
  const firstMs = Date.UTC(year, monthIndex, 1);
  const startMs = firstMs - new Date(firstMs).getUTCDay() * MS_PER_DAY;

  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const ms = startMs + i * MS_PER_DAY;
    const d = new Date(ms);
    cells.push({
      date: toIso(ms),
      day: d.getUTCDate(),
      outside: d.getUTCMonth() !== monthIndex || d.getUTCFullYear() !== year,
    });
  }
  return cells;
}
