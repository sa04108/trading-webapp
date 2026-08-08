/** `useStrategies` 응답 중 라벨에 필요한 부분만 — 화면마다 전체 타입을 끌고 오지 않게 */
export interface StrategyNameSource {
  readonly id: string;
  readonly name: string;
}

/**
 * 화면에 보일 전략 이름. 목록에 없거나 응답이 아직 없으면 strategyId 로 떨어진다 —
 * 등록이 풀린 전략의 지난 결과가 빈칸으로 보이면 무슨 전략이었는지 알 수 없다.
 */
export function strategyLabel(
  strategyId: string,
  strategies: readonly StrategyNameSource[] | undefined,
): string {
  return strategies?.find((s) => s.id === strategyId)?.name ?? strategyId;
}
