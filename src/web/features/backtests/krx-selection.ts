// 확장자 .js 는 실수가 아니다 — tests/unit/krx-selection.test.ts 가 이 모듈을 import 해
// tsconfig.server.json 의 NodeNext 프로그램에 편입되는데, 거기서는 확장자 없는 상대
// import 가 에러다 (prefill.ts·wizard-steps.ts 와 같은 이유). 이 모듈은 DOM 을 쓰지
// 않고 별칭(@/) import 도 쓰지 않는다.
import type { HistoricalCandidateDto } from '../../../shared/schemas/historical-universe.js';

/**
 * 후보 중 시가총액 순위(rank) 기준 상위 N개의 standardCode 를 뽑는다.
 *
 * rank 는 서버가 매긴 결정적 순위다 — 화면은 다시 정렬하지 않고 그 값만 기준으로
 * 삼는다. rank 가 없는 후보(시가총액 unknown)는 크기를 알 수 없어 「상위」를 판단할
 * 근거가 없으므로 상위 N 후보에서 제외한다.
 */
export function topNCodes(candidates: readonly HistoricalCandidateDto[], n: number): readonly string[] {
  return candidates
    .filter((candidate) => candidate.rank !== null)
    .slice()
    .sort((a, b) => (a.rank as number) - (b.rank as number))
    .slice(0, Math.max(0, n))
    .map((candidate) => candidate.standardCode);
}

/**
 * 지금 선택이 「시가총액 상위 N」 규칙 그대로인지, 사용자가 손으로 바꿨는지 판별한다.
 *
 * 선택 집합이 상위 N 코드 집합과 정확히 같을 때만 `TOP_MARKET_CAP_N` 이다 — 하나라도
 * 빼거나 다른 종목을 더하면 그 순간부터 「시가총액 상위 N」이라는 설명이 사실과
 * 어긋나므로 `MANUAL_FROM_KRX_SNAPSHOT` 으로 내려간다.
 *
 * 이 판정은 검색어·페이지 상태를 보지 않는다 — `candidates` 는 화면에 지금 보이는
 * 페이지가 아니라 언제나 전체 후보를 받아야 한다. 그래야 선택이 검색·페이지 이동과
 * 무관하게 유지된다.
 */
export function selectionMethodOf(
  selected: ReadonlySet<string>,
  candidates: readonly HistoricalCandidateDto[],
  n: number,
): 'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT' {
  const top = topNCodes(candidates, n);
  if (top.length !== selected.size) return 'MANUAL_FROM_KRX_SNAPSHOT';
  return top.every((code) => selected.has(code)) ? 'TOP_MARKET_CAP_N' : 'MANUAL_FROM_KRX_SNAPSHOT';
}
