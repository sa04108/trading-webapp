/**
 * Task 1 호환 요약 — 단계 편집기(Task 9)가 들어오기 전에는 첫 MARKET_CAP 단계를
 * 기존 화면의 상위 N 표기로 보인다.
 *
 * 실제 리밸런스 결과 종목 수는 적지 않는다 — 종목 구성은 더 이상 저장된 값이 아니라
 * 제출 시점에 서버가 규칙으로 재구성한 멤버십 일정이라, 그 수를 알려면 다시 미리보기를
 * 조회해야 한다. 목록·상세 화면의 요약 한 줄을 위해 그 비용을 치르지 않는다.
 */
export function formatUniverseRuleSummary(rule: {
  markets: readonly string[];
  stages: readonly { criterion: string; limit: number }[];
}): string {
  return `${rule.markets.join('·')} 시가총액 상위 ${rule.stages[0]?.limit ?? 0}`;
}
