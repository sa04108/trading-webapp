import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';

/**
 * 등록된 전략의 현재 버전.
 *
 * 테스트가 버전 리터럴을 들고 있으면 전략을 개정할 때마다 표류한다 — hourly-breakout
 * v1.2.0 을 range-breakout v2.0.0 으로 다시 쓴 개정에서 job-queue 테스트가 '1.2.0' 을
 * 붙들고 있다가 배포 검증 게이트를 막았다 (제품은 멀쩡했다).
 *
 * 버전은 손으로 올리는 선언이라 기계가 파생시켜 주지 않는다. 그래서 값을 아는 유일한
 * 출처인 레지스트리에서 받아 쓴다. 제출 검증(backtest-routes)이 요청 버전과 등록 버전의
 * 일치를 요구하므로, 요청을 만드는 쪽은 전부 이 함수를 거쳐야 한다.
 *
 * 반대로 "과거 스키마의 요청" 을 흉내 내는 값(예: '1.1.0')은 현재 버전과 다르기만 하면
 * 되므로 리터럴로 둔다 — 그건 등록된 전략을 가리키는 값이 아니다.
 */
const registry = new StrategyRegistry();

export function currentStrategyVersion(strategyId: string): string {
  const strategy = registry.get(strategyId);
  if (!strategy) throw new Error(`등록되지 않은 전략: ${strategyId}`);
  return strategy.version;
}
