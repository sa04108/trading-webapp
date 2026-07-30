/** 페이지당 표시 수 입력 파싱 — 빈 값·비숫자는 기본값, 1~max 클램프 (max 기본 200) */
export function parsePageSize(text: string, fallback: number, max = 200): number {
  const parsed = Number.parseInt(text, 10);
  return Math.min(max, Math.max(1, Number.isNaN(parsed) ? fallback : parsed));
}
