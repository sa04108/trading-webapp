/**
 * 백테스트가 실제 소비한 봉 주기 (설계 2026-07-30-backtest-result-display-design.md §3).
 *
 * **요청이 유일한 출처다.** 데이터셋에서 `defaultTimeframe` 이 없어진 뒤
 * (D-034) 폴백할 근거가 사라졌다 — 제출 검증이 해소한 값을 저장 요청에 박아 넣으므로
 * 지금 만들어지는 잡은 항상 이 필드를 갖는다. 그 이전에 만들어진 잡은 데이터셋에서
 * 추론할 수 없으므로 null 이고, 화면은 「기록 없음」으로 표시한다 — 없는 근거로
 * 추측한 값을 "실제로 소비한 봉" 이라고 적으면 그게 더 나쁘다.
 */
export function resolveJobTimeframe(job: { request: { timeframe?: string } }): string | null {
  return job.request.timeframe ?? null;
}
