/**
 * 페이지당 표시 수 입력 파싱 — 빈 값·비숫자는 기본값, 1~max 클램프 (max 기본 200).
 *
 * 거래 내역·경고 목록·종목 목록이 같은 컨트롤을 쓴다. 탭마다 따로 파싱하면 한쪽만
 * 음수를 막거나 상한이 달라져 같은 입력이 자리마다 다르게 동작한다 — 그래서 `lib` 에 둔다.
 */
export function parsePageSize(text: string, fallback: number, max = 200): number {
  const parsed = Number.parseInt(text, 10);
  return Math.min(max, Math.max(1, Number.isNaN(parsed) ? fallback : parsed));
}
