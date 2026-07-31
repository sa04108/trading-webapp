/**
 * 전략이 재무제표를 신호에 쓰는지 카드에서 바로 읽히게 하는 표시.
 *
 * 두 상태를 모두 표시하는 이유: 배지가 없는 카드를 "봉만 쓴다" 로 읽을 수 없다 —
 * 표시가 빠진 것과 구분되지 않는다. 봉 지표만으로 매매하려는 사용자에게는 "이 전략은
 * 재무를 안 본다" 가 "이 전략은 재무를 본다" 와 같은 무게의 정보다.
 */
export type StrategyDataRequirement = 'FUNDAMENTALS' | 'BARS_ONLY';

/**
 * 필드가 없으면 null — 배지를 아예 안 그린다. `undefined` 를 false 로 뭉개면 재무
 * 전략에 「봉 데이터만」이 붙어, 사용자가 피하려던 상황을 화면이 보증해 버린다.
 * 잘못 안심시키는 것보다 말하지 않는 게 낫다.
 */
export function strategyDataRequirement(
  requiresFundamentals: boolean | undefined,
): StrategyDataRequirement | null {
  if (requiresFundamentals === undefined) return null;
  return requiresFundamentals ? 'FUNDAMENTALS' : 'BARS_ONLY';
}

export const STRATEGY_DATA_LABELS: Record<StrategyDataRequirement, string> = {
  FUNDAMENTALS: '재무 필요',
  BARS_ONLY: '봉 데이터만',
};

/**
 * 배지 문구만으로는 무엇이 필요한지, 무엇이 개입하지 않는지까지는 알 수 없다.
 * 고른 카드에서 한 줄로 풀어 준다 — 재무 쪽은 제출 단계에서 받을 422(재무 미수집
 * 데이터셋 거부)를 여기서 미리 알려주는 자리이기도 하다.
 */
// 두 문장을 같은 골격으로 맞춘다 — "무엇을 쓰는가 — 재무가 개입하는가" 순서가 같아야
// 카드를 옮겨 다닐 때 뒷절만 읽고도 차이가 잡힌다
export const STRATEGY_DATA_DETAILS: Record<StrategyDataRequirement, string> = {
  FUNDAMENTALS:
    '시세 봉과 함께 재무제표가 신호에 개입합니다 — 재무를 수집한 데이터셋에서만 실행됩니다.',
  BARS_ONLY: '시세 봉(OHLCV)만 사용합니다 — 재무제표는 신호에 개입하지 않습니다.',
};
