/**
 * 경고 목록을 같은 종류끼리 묶는다 (설계 2026-07-30-warning-grouping-design.md).
 * 정규화 키 = ISO 타임스탬프 괄호와 종목 코드 프리픽스를 지운 문자열.
 * 한글로 시작하는 1회성 요약 라인은 두 패턴에 걸리지 않아 자기 자신이 키다.
 */
const TIMESTAMP_PAREN = /\s*\(\d{4}-\d{2}-\d{2}T[^)]*\)/g;
const SYMBOL_PREFIX = /^[A-Za-z0-9._-]{1,20} /;

function normalize(warning: string): string {
  return warning.replace(TIMESTAMP_PAREN, '').replace(SYMBOL_PREFIX, '').trim();
}

export function groupWarnings(
  warnings: readonly string[],
): Array<{ label: string; count: number }> {
  const byKey = new Map<string, { first: string; count: number }>();
  for (const warning of warnings) {
    const key = normalize(warning);
    const entry = byKey.get(key);
    if (entry) entry.count += 1;
    else byKey.set(key, { first: warning, count: 1 });
  }
  return [...byKey.entries()].map(([key, { first, count }]) => ({
    label: count > 1 ? `${key} (${count}건)` : first,
    count,
  }));
}
