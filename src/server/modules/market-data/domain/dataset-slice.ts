import type { Timeframe } from './candle.js';

/**
 * 데이터셋 봉 슬라이스 (설계 2026-07-30-dataset-symbol-group-design.md §1).
 * 데이터셋 = 종목 그룹이고, 봉 데이터는 일봉('1d')과 분봉('1m') 두 슬라이스로
 * 나뉜다. 분봉 슬라이스는 1m 수집 + 1h 집계를 함께 보관한다 (기존 1h 종류의 실체).
 */
export type DatasetSlice = '1d' | '1m';

export const ALL_SLICES: readonly DatasetSlice[] = ['1d', '1m'];

/** 슬라이스가 보관하는 timeframe 목록 — 백테스트·검증 차트의 선택지 원천 */
export function sliceTimeframes(slice: DatasetSlice): Timeframe[] {
  return slice === '1m' ? ['1m', '1h'] : ['1d'];
}

/** 증권사에서 수집하는 봉 — 수집은 1m 또는 1d 뿐이다 */
export function collectTimeframeForSlice(slice: DatasetSlice): '1d' | '1m' {
  return slice;
}

/**
 * 커버리지 계산 기준 봉. 분봉 슬라이스는 1h 기준 — 시간봉 커버리지만 세션에서
 * 기대 봉 수를 계산할 수 있다 (domain/coverage.ts 의 computeHourlyCoverage).
 */
export function coverageTimeframeForSlice(slice: DatasetSlice): Timeframe {
  return slice === '1m' ? '1h' : '1d';
}

/** 소비 봉이 속한 슬라이스 — 백테스트 검증이 어느 슬라이스 커버리지를 볼지 결정 */
export function sliceForTimeframe(timeframe: Timeframe): DatasetSlice {
  return timeframe === '1d' ? '1d' : '1m';
}

/**
 * timeframe 없는 저장된 백테스트 요청의 소비 봉. 이 필드가 없던 시절 엔진은
 * 데이터셋 timeframe(분봉 데이터셋 = '1h')을 썼다 — 같은 결과를 유지한다.
 */
export function legacyConsumeDefault(defaultTimeframe: DatasetSlice): Timeframe {
  return defaultTimeframe === '1m' ? '1h' : '1d';
}

/** 종목 구성 유일키 — 정렬·중복 제거. 구성이 같으면 순서와 무관하게 같은 키다 */
export function symbolsKey(symbols: readonly string[]): string {
  return [...new Set(symbols)].sort().join(',');
}

