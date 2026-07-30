/**
 * 백테스트가 메모리에 올릴 봉 수 상한 (설계 2026-07-29-backtest-timeframe-design.md).
 * 실행부는 기간 내 전체 봉을 배열로 올린다 — 1m 소비를 열면서 OOM 을 막는 밸브다.
 * 2M 봉 ≈ 수백 MB JS 힙. 초과는 다운샘플 없이 명시적으로 거부한다.
 *
 * backtest 도메인이 정의를 소유하지만 market-data(분봉 백필 사전 계획, §coverage)도
 * 같은 상한을 참조해야 한다. 두 모듈 중 한쪽의 domain 에 두면 반대쪽이 그 모듈에
 * 의존하게 돼 §7 의존 방향(모듈 경계)이 깨진다 — 그래서 어느 모듈에도 속하지 않는
 * shared 에 둔다. backtest/domain/bar-estimate.ts 는 하위 호환을 위해 이 값을
 * re-export 한다.
 */
export const MAX_BACKTEST_BARS = 2_000_000;
