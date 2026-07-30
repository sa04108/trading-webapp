/** 데이터셋 봉 슬라이스 표시·판정 (설계 §3·§4). 서버 dataset-slice.ts 와 값 계약 동일 */
export type DatasetSlice = '1d' | '1m';
export interface SliceState {
  slice: DatasetSlice;
  hasData: boolean;
}

export function sliceLabel(slice: DatasetSlice): string {
  return slice === '1d' ? '일봉' : '분봉';
}

export function sliceHasData(slices: readonly SliceState[], slice: DatasetSlice): boolean {
  return slices.some((s) => s.slice === slice && s.hasData);
}

/**
 * request.timeframe 이 없는 옛 잡의 소비 봉 폴백 — 서버 legacyConsumeDefault 와 같은 규칙.
 * '1m' → '1h', '1d' → '1d'.
 */
export function legacyConsumeTimeframe(defaultTimeframe: DatasetSlice): '1h' | '1d' {
  return defaultTimeframe === '1m' ? '1h' : '1d';
}

/** 백테스트 위저드 봉 주기 선택지 — 데이터 있는 슬라이스에서만. 소비 기본(1d, 1h)이 앞 */
export function wizardTimeframes(slices: readonly SliceState[]): Array<'1m' | '1h' | '1d'> {
  const result: Array<'1m' | '1h' | '1d'> = [];
  if (sliceHasData(slices, '1d')) result.push('1d');
  if (sliceHasData(slices, '1m')) result.push('1h', '1m');
  return result;
}
